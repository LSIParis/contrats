# Phase E — Éditeur de contenu (§6.4 minimal) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doter un contrat d'un corps rédigé (WYSIWYG), enregistré comme versions immuables, avec aperçu PDF via la vraie chaîne de rendu.

**Architecture:** Endpoints NestJS scopés/gardés par rôle : enregistrer le contenu crée une `ContractVersion` immuable (bodyHtml assaini côté serveur) et pointe `currentVersionId` ; l'aperçu rend la version courante via `DocumentRenderer` (Gotenberg). Front SPA : éditeur WYSIWYG TipTap, historique, boutons édition/aperçu.

**Tech Stack:** NestJS 10, Prisma 5, `sanitize-html`, React 18, TipTap 2, TanStack Query 5, Vitest + Testing Library + supertest + Testcontainers.

## Global Constraints

- **Monorepo pnpm** ; front = `@lsi/web`. Node 22, pnpm 9.15.9. Runtime API en **SWC** (jamais tsx).
- **Sécurité** : tout endpoint scopé par le `ScopeGuard` global (aucun `@Public()`). **404 (jamais 403) hors scope** (RM-30) ; **403** rôle insuffisant (`assertRole` MSP_ADMIN/ACCOUNT_MANAGER) ; **409** édition hors statut éditable ; **422** aperçu sans version. Data via `withScope`. Le front ne porte AUCUNE autorisation.
- **Édition autorisée seulement en statut éditable** : `EDITABLE_STATUSES = ['DRAFT','CHANGES_REQUESTED']` (de `@lsi/domain`).
- **bodyHtml assaini côté serveur** avant persistance (allowlist).
- **Versions immuables** : jamais `UPDATE`/`DELETE`.
- **UI en français.** Interdit `$queryRawUnsafe`/`$executeRawUnsafe` hors testing. **CI** (`lint`+`typecheck`+`test`) verte, `apps/web` inclus.
- **Pattern de test API** : `SessionService.put({ sessionId, userId, tenantId, roles, scope })` + en-tête `x-lsi-session`. Renderer en test : `new FakeRenderer()` (de `apps/api/tests/support/fakes.js`), fourni via `.overrideProvider(DOCUMENT_RENDERER).useValue(renderer)`.
- **Fixture** `seedTwoCustomers()` — mais elle crée des contrats en statut `DRAFT` (`customerA.contractId`, `customerB.contractId`), éditables. Utiliser ces contrats.

---

## Structure de fichiers

**API**
- Create: `apps/api/src/documents/html-sanitizer.ts`
- Create: `apps/api/src/contracts/dto/save-content.dto.ts`
- Create: `apps/api/src/contracts/content.service.ts`, `apps/api/src/contracts/content.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json` (dép. `sanitize-html`, `@types/sanitize-html`)

**Front (`apps/web`)**
- Modify: `apps/web/package.json` (dép. `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`)
- Create: `apps/web/src/features/contracts/content-editor.tsx`
- Create: `apps/web/src/features/contracts/contract-edit-page.tsx`
- Create: `apps/web/src/features/contracts/versions-page.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (bloc « Contenu »)
- Modify: `apps/web/src/app.tsx` (routes)

---

## Task 1 : `PUT /v1/contracts/:id/content` (enregistrer une version + assainissement)

**Files:**
- Modify: `apps/api/package.json` (ajouter `sanitize-html` + `@types/sanitize-html`)
- Create: `apps/api/src/documents/html-sanitizer.ts`
- Create: `apps/api/src/contracts/dto/save-content.dto.ts`
- Create: `apps/api/src/contracts/content.service.ts`, `apps/api/src/contracts/content.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/content-save.test.ts`

**Interfaces:**
- Produces: `sanitizeContractHtml(html: string): string` (retire scripts/handlers, garde l'allowlist).
- Produces: `PUT /v1/contracts/:id/content` → `{ id, versionNumber }`. 403 rôle, 409 hors statut éditable, 404 hors scope.

- [ ] **Step 1 : Installer la dépendance**

Run: `pnpm --filter @lsi/api add sanitize-html && pnpm --filter @lsi/api add -D @types/sanitize-html`
Expected: `sanitize-html` dans `apps/api/package.json`.

- [ ] **Step 2 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/content-save.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  await sessions.put({
    sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('PUT /v1/contracts/:id/content', () => {
  test('enregistre une version, incrémente le numéro, pose currentVersionId, assainit', async () => {
    const r1 = await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a')
      .send({ bodyHtml: '<p>Bonjour</p><script>alert(1)</script>', changeSummary: 'init' })
      .expect(200);
    expect(r1.body.versionNumber).toBe(1);

    const r2 = await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a')
      .send({ bodyHtml: '<p>Deuxième</p>' })
      .expect(200);
    expect(r2.body.versionNumber).toBe(2);

    const [contract, version] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: fx.customerA.contractId }, select: { currentVersionId: true } }),
      await tx.contractVersion.findUnique({ where: { id: r1.body.id }, select: { bodyHtml: true } }),
    ]);
    expect(contract!.currentVersionId).toBe(r2.body.id);
    expect(version!.bodyHtml).toContain('Bonjour');
    expect(version!.bodyHtml).not.toContain('<script>'); // assaini
  });

  test('rôle insuffisant (TECHNICIAN) → 403', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-tech').send({ bodyHtml: '<p>x</p>' }).expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerB.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>x</p>' }).expect(404);
  });
});
```

- [ ] **Step 3 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-save.test.ts`
Expected: FAIL (404, route absente).

- [ ] **Step 4 : Assainisseur**

```typescript
// apps/api/src/documents/html-sanitizer.ts
import sanitizeHtml from 'sanitize-html';

/**
 * Assainit le corps d'un contrat. (§6.4)
 *
 * bodyHtml est une entrée utilisateur qui sera rendue par un Chromium
 * (Gotenberg). Le rendu est sandboxé, mais on retire scripts et gestionnaires
 * d'événements À LA SOURCE — allowlist alignée sur les capacités de l'éditeur
 * (titres, gras/italique, listes, paragraphes, liens).
 */
export function sanitizeContractHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}
```

- [ ] **Step 5 : DTO**

```typescript
// apps/api/src/contracts/dto/save-content.dto.ts
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SaveContentDto {
  @IsString()
  @MaxLength(500_000)
  bodyHtml!: string;

  @IsOptional() @IsString() @MaxLength(500)
  changeSummary?: string;
}
```

- [ ] **Step 6 : Service**

```typescript
// apps/api/src/contracts/content.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { EDITABLE_STATUSES } from '@lsi/domain';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import type { SaveContentDto } from './dto/save-content.dto.js';

@Injectable()
export class ContentService {
  async saveContent(scope: Scope, id: string, dto: SaveContentDto) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        select: { id: true, tenantId: true, customerId: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({
          code: 'RM-04',
          detail: 'Le contenu ne peut être édité que sur un brouillon ou un contrat renvoyé pour modification.',
        });
      }

      const clean = sanitizeContractHtml(dto.bodyHtml);
      const max = await tx.contractVersion.aggregate({
        where: { contractId: id },
        _max: { versionNumber: true },
      });
      const versionNumber = (max._max.versionNumber ?? 0) + 1;
      const now = new Date();

      const version = await tx.contractVersion.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
          versionNumber, bodyHtml: clean, variables: {}, changeSummary: dto.changeSummary ?? null,
          createdAt: now, createdByUserId: scope.userId,
        },
        select: { id: true, versionNumber: true },
      });
      await tx.contract.update({
        where: { id },
        data: { currentVersionId: version.id, updatedAt: now, updatedByUserId: scope.userId },
      });
      return version;
    });
  }
}
```

- [ ] **Step 7 : Contrôleur + enregistrement**

```typescript
// apps/api/src/contracts/content.controller.ts
import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { ContentService } from './content.service.js';
import { SaveContentDto } from './dto/save-content.dto.js';

@Controller('v1/contracts')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Put(':id/content')
  save(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveContentDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.content.saveContent(scope, id, dto);
  }
}
```

Dans `app.module.ts` : ajouter `ContentController` (controllers) et `ContentService` (providers).

Vérifier : `EDITABLE_STATUSES` exporté par `@lsi/domain` ; `scope.userId` disponible sur `Scope` ; `PUT` renvoie 200 par défaut (Nest).

- [ ] **Step 8 : Lancer, vérifier le succès + suite complète**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-save.test.ts && pnpm exec vitest run`
Expected: PASS (content-save 3/3) puis suite complète verte.

- [ ] **Step 9 : Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/documents/html-sanitizer.ts apps/api/src/contracts apps/api/src/app.module.ts apps/api/tests/isolation/content-save.test.ts
git commit -m "feat(api): PUT /v1/contracts/:id/content — versions + assainissement HTML"
```

---

## Task 2 : `GET …/versions` (liste) + `GET …/versions/:versionId` (contenu)

**Files:**
- Modify: `apps/api/src/contracts/content.service.ts`, `apps/api/src/contracts/content.controller.ts`
- Test: `apps/api/tests/isolation/content-versions.test.ts`

**Interfaces:**
- Produces: `GET /v1/contracts/:id/versions` → `{ items: [{ id, versionNumber, changeSummary, createdAt }] }` (plus récent d'abord). `GET /v1/contracts/:id/versions/:versionId` → `{ id, versionNumber, bodyHtml, createdAt }`, 404 hors scope.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/content-versions.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let versionId: string;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  const r = await request(app.getHttpServer())
    .put(`/v1/contracts/${fx.customerA.contractId}/content`)
    .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Contenu A</p>' });
  versionId = r.body.id;
});

describe('GET versions', () => {
  test('liste les versions du contrat', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/versions`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items.some((v: any) => v.id === versionId)).toBe(true);
    expect(res.body.items[0].versionNumber).toBeGreaterThanOrEqual(1);
  });

  test('lit le contenu d’une version', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/versions/${versionId}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.bodyHtml).toContain('Contenu A');
  });

  test('IDOR : versions du contrat de B → 404', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerB.contractId}/versions`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-versions.test.ts`
Expected: FAIL (404).

- [ ] **Step 3 : Méthodes service**

Dans `content.service.ts`, ajouter :

```typescript
  async listVersions(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      // Le contrat doit être dans le scope, sinon 404 (RLS l'a déjà masqué).
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const items = await tx.contractVersion.findMany({
        where: { contractId: id },
        orderBy: { versionNumber: 'desc' },
        select: { id: true, versionNumber: true, changeSummary: true, createdAt: true },
      });
      return { items };
    });
  }

  async getVersion(scope: Scope, id: string, versionId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const v = await tx.contractVersion.findFirst({
        where: { id: versionId, contractId: id },
        select: { id: true, versionNumber: true, bodyHtml: true, createdAt: true },
      });
      if (!v) throw new NotFoundException('Version introuvable');
      return v;
    });
  }
```

- [ ] **Step 4 : Routes contrôleur**

```typescript
import { Get } from '@nestjs/common';
// … dans la classe :
  @Get(':id/versions')
  list(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.listVersions(scope, id);
  }

  @Get(':id/versions/:versionId')
  one(
    @CurrentScope() scope: Scope,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.content.getVersion(scope, id, versionId);
  }
```

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-versions.test.ts tests/isolation/content-save.test.ts`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts apps/api/tests/isolation/content-versions.test.ts
git commit -m "feat(api): GET versions (liste + contenu) scopés"
```

---

## Task 3 : `GET /v1/contracts/:id/preview.pdf` (aperçu via Gotenberg)

**Files:**
- Modify: `apps/api/src/contracts/content.service.ts`, `apps/api/src/contracts/content.controller.ts`
- Test: `apps/api/tests/isolation/content-preview.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_RENDERER` (`DocumentRenderer.render({ html, documentTitle }) => { pdf: Buffer, sha256 }`), token dans `apps/api/src/documents/renderer.token.js`.
- Produces: `GET /v1/contracts/:id/preview.pdf` → PDF (`application/pdf`). 422 sans version courante, 404 hors scope.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/content-preview.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { FakeRenderer } from '../support/fakes.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let renderer: FakeRenderer;

beforeAll(async () => {
  renderer = new FakeRenderer();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOCUMENT_RENDERER).useValue(renderer).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('GET /v1/contracts/:id/preview.pdf', () => {
  test('sans version courante → 422', async () => {
    // customerB.contractId n'a pas de contenu ; on s'authentifie comme admin B ?
    // Plus simple : le contrat A n'a pas encore de version au tout début.
    await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/preview.pdf`).set('x-lsi-session', 'sess-am-a').expect(422);
  });

  test('avec une version → PDF rendu par la chaîne réelle', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Texte du contrat</p>' }).expect(200);

    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/preview.pdf`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Le FakeRenderer a bien reçu le bodyHtml de la version.
    expect(renderer.lastHtml).toContain('Texte du contrat');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-preview.test.ts`
Expected: FAIL (404).

- [ ] **Step 3 : Injecter le renderer + méthode service**

Dans `content.service.ts`, ajouter au constructeur l'injection du renderer et la méthode :

```typescript
import { Inject, UnprocessableEntityException } from '@nestjs/common';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import type { DocumentRenderer } from '@lsi/domain';
// … constructeur :
  constructor(@Inject(DOCUMENT_RENDERER) private readonly renderer: DocumentRenderer) {}

  async previewPdf(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        select: { id: true, title: true, currentVersionId: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!c.currentVersionId) throw new UnprocessableEntityException('Aucune version à prévisualiser');
      const version = await tx.contractVersion.findUnique({
        where: { id: c.currentVersionId },
        select: { bodyHtml: true },
      });
      if (!version) throw new UnprocessableEntityException('Version introuvable');
      const rendered = await this.renderer.render({ html: version.bodyHtml, documentTitle: c.title });
      return rendered.pdf;
    });
  }
```

- [ ] **Step 4 : Route contrôleur (stream)**

```typescript
import { Res } from '@nestjs/common';
import type { Response } from 'express';
// … dans la classe :
  @Get(':id/preview.pdf')
  async preview(
    @CurrentScope() scope: Scope,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    // La méthode lève AVANT d'écrire dans `res` (404/422) : le filtre
    // d'exception de Nest répond alors normalement.
    const pdf = await this.content.previewPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="apercu.pdf"');
    res.send(pdf);
  }
```

- [ ] **Step 5 : Lancer, vérifier le succès + suite complète**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/content-preview.test.ts && pnpm exec vitest run`
Expected: PASS. Si la route `:id/preview.pdf` ne matche pas (le point dans le chemin), utiliser `:id/preview` et ajuster le test et le front en conséquence — vérifier d'abord avec le point.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts apps/api/tests/isolation/content-preview.test.ts
git commit -m "feat(api): GET preview.pdf — aperçu de la version courante (Gotenberg)"
```

---

## Task 4 : Front — composant éditeur WYSIWYG (TipTap)

**Files:**
- Modify: `apps/web/package.json` (dép. `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`)
- Create: `apps/web/src/features/contracts/content-editor.tsx`
- Test: `apps/web/src/test/content-editor.test.tsx`

**Interfaces:**
- Produces: `<ContentEditor initialHtml saving onSave onPreview />` — `onSave(html: string)` appelé au clic sur « Enregistrer » avec le HTML courant (suivi via l'état, initialisé à `initialHtml`). Barre d'outils gras/italique/titre/liste. Bouton « Aperçu PDF » → `onPreview()`.

- [ ] **Step 1 : Installer les dépendances**

Run: `pnpm --filter @lsi/web add @tiptap/react @tiptap/starter-kit @tiptap/pm`
Expected: les trois dans `apps/web/package.json`.

- [ ] **Step 2 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/content-editor.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentEditor } from '../features/contracts/content-editor.js';

test('« Enregistrer » renvoie le HTML initial si non modifié', async () => {
  const onSave = vi.fn();
  render(<ContentEditor initialHtml="<p>Bonjour</p>" saving={false} onSave={onSave} onPreview={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(String(onSave.mock.calls[0][0])).toContain('Bonjour');
});

test('bouton Aperçu PDF présent', () => {
  render(<ContentEditor initialHtml="<p>x</p>" saving={false} onSave={() => {}} onPreview={() => {}} />);
  expect(screen.getByRole('button', { name: /Aperçu PDF/ })).toBeInTheDocument();
});
```

- [ ] **Step 3 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/content-editor.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 4 : Implémenter**

```tsx
// apps/web/src/features/contracts/content-editor.tsx
import { useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

export function ContentEditor({
  initialHtml, saving, onSave, onPreview,
}: {
  initialHtml: string;
  saving: boolean;
  onSave: (html: string) => void;
  onPreview: () => void;
}) {
  // L'état suit le HTML ; initialisé à initialHtml, mis à jour à chaque frappe.
  // « Enregistrer » envoie cet état — pas besoin d'interroger l'éditeur au clic.
  const [html, setHtml] = useState(initialHtml);
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    onUpdate: ({ editor }) => setHtml(editor.getHTML()),
  });

  const tb = 'rounded border px-2 py-1 text-sm hover:bg-gray-100';
  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBold().run()}><b>G</b></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Liste</button>
      </div>
      <div className="rounded border p-3 min-h-[240px] prose max-w-none">
        <EditorContent editor={editor} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(html)}
          disabled={saving}
          className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button type="button" onClick={onPreview} className="rounded border px-4 py-2 text-sm">Aperçu PDF</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/content-editor.test.tsx` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS + typecheck clean. Si `useEditor` lève en jsdom (ProseMirror), envelopper le rendu de `EditorContent` derrière `editor && (...)` (déjà le cas via l'API optionnelle) ; l'état `html` reste `initialHtml` sans interaction, donc le test tient sans dépendre du moteur.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/features/contracts/content-editor.tsx apps/web/src/test/content-editor.test.tsx
git commit -m "feat(web): composant éditeur WYSIWYG TipTap"
```

---

## Task 5 : Front — page d'édition `/contracts/:id/edit`

**Files:**
- Create: `apps/web/src/features/contracts/contract-edit-page.tsx`
- Modify: `apps/web/src/app.tsx` (route `/contracts/:id/edit`)
- Test: `apps/web/src/test/contract-edit.test.tsx`

**Interfaces:**
- Consumes: `<ContentEditor>` (Task 4), `apiGet`/`apiPost` (le PUT est fait via `fetch`/`apiPut` — voir Step 3), `Spinner`.
- Produces: `<ContractEditPage/>` — charge le contenu de la version courante, `[Enregistrer]` → `PUT /v1/contracts/:id/content` → navigation vers `/contracts/:id`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/contract-edit.test.tsx
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractEditPage } from '../features/contracts/contract-edit-page.js';

// L'éditeur TipTap est remplacé par un stub : ce test cible la logique de
// chargement/sauvegarde/navigation, pas le moteur d'édition (couvert en Task 4).
vi.mock('../features/contracts/content-editor.js', () => ({
  ContentEditor: ({ onSave }: { onSave: (h: string) => void }) => (
    <button onClick={() => onSave('<p>édité</p>')}>Enregistrer</button>
  ),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts/k1/edit']}>
        <Routes>
          <Route path="/contracts/:id/edit" element={<ContractEditPage />} />
          <Route path="/contracts/:id" element={<div>Fiche contrat</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('charge le contrat, enregistre le contenu et revient à la fiche', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/contracts/k1') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ contract: { status: 'DRAFT', currentVersionId: null }, customer: { name: 'X' }, signatureRequest: null, reminders: [], timeline: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // PUT content
    expect(init?.method).toBe('PUT');
    return new Response(JSON.stringify({ id: 'v1', versionNumber: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Enregistrer/ })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
  await waitFor(() => expect(screen.getByText('Fiche contrat')).toBeInTheDocument());
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/contract-edit.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Ajouter `apiPut` puis implémenter la page**

Ajouter à `apps/web/src/lib/api.ts` (à côté de `apiPost`) :
```typescript
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
    } catch { /* corps non-JSON */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
```

```tsx
// apps/web/src/features/contracts/contract-edit-page.tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { ContentEditor } from './content-editor.js';

interface Detail { contract: { status: string; currentVersionId: string | null } }
interface Version { bodyHtml: string }

const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];

export function ContractEditPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const versionId = detail.data?.contract.currentVersionId ?? null;
  const version = useQuery({
    queryKey: ['version', id, versionId],
    queryFn: () => apiGet<Version>(`/v1/contracts/${id}/versions/${versionId}`),
    enabled: !!versionId,
  });

  const m = useMutation({
    mutationFn: (html: string) => apiPut<{ id: string }>(`/v1/contracts/${id}/content`, { bodyHtml: html }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', id] });
      qc.invalidateQueries({ queryKey: ['versions', id] });
      nav(`/contracts/${id}`);
    },
  });

  if (detail.isLoading || (versionId && version.isLoading)) return <Spinner />;
  if (detail.error || !detail.data) return <p className="text-red-600">Contrat introuvable.</p>;
  if (!EDITABLE.includes(detail.data.contract.status)) {
    return <p className="text-gray-600">Ce contrat n’est pas modifiable dans son état actuel.</p>;
  }

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Éditer le contenu</h1>
      <ContentEditor
        initialHtml={version.data?.bodyHtml ?? ''}
        saving={m.isPending}
        onSave={(html) => m.mutate(html)}
        onPreview={() => window.open(`/v1/contracts/${id}/preview.pdf`, '_blank', 'noopener')}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4 : Route**

Dans `app.tsx`, ajouter AVANT `/contracts/:id` :
```tsx
<Route path="/contracts/:id/edit" element={<ContractEditPage />} />
```

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/contract-edit.test.tsx` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): page d'édition du contenu (charge version courante, enregistre)"
```

---

## Task 6 : Front — bloc « Contenu » sur la fiche + historique des versions

**Files:**
- Create: `apps/web/src/features/contracts/versions-page.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (bloc « Contenu »), `apps/web/src/app.tsx` (route `/contracts/:id/versions`)
- Test: `apps/web/src/test/versions-page.test.tsx`

**Interfaces:**
- Produces: `<VersionsPage/>` (route `/contracts/:id/versions`), et un bloc « Contenu » sur la fiche avec liens vers l'édition, l'aperçu, l'historique.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/versions-page.test.tsx
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionsPage } from '../features/contracts/versions-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><VersionsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche l’historique des versions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ items: [{ id: 'v2', versionNumber: 2, changeSummary: 'maj', createdAt: '2026-07-19' }, { id: 'v1', versionNumber: 1, changeSummary: 'init', createdAt: '2026-07-18' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
  wrap();
  await waitFor(() => expect(screen.getByText(/Version 2/)).toBeInTheDocument());
  expect(screen.getByText(/Version 1/)).toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/versions-page.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter l'historique**

```tsx
// apps/web/src/features/contracts/versions-page.tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

interface VersionRow { id: string; versionNumber: number; changeSummary: string | null; createdAt: string; }

export function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['versions', id], queryFn: () => apiGet<{ items: VersionRow[] }>(`/v1/contracts/${id}/versions`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Erreur de chargement.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Historique des versions</h1>
      {q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucune version.</p>
      ) : (
        <Table head={<tr><th className="py-2">Version</th><th>Résumé</th><th>Date</th></tr>}>
          {q.data.items.map((v) => (
            <tr key={v.id} className="border-b">
              <td className="py-2">Version {v.versionNumber}</td>
              <td>{v.changeSummary ?? '—'}</td>
              <td>{new Date(v.createdAt).toLocaleDateString('fr-FR')}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : Bloc « Contenu » sur la fiche + routes**

Dans `contract-detail-page.tsx`, importer `Link` (déjà importé) et `Card`, et ajouter un bloc après l'en-tête (avant le bloc signature), en utilisant `contract.status` et `contract.currentVersionId` (déjà présents dans la réponse `findOne`) :

```tsx
      <Card title="Contenu">
        <div className="flex flex-wrap gap-3 text-sm">
          {['DRAFT', 'CHANGES_REQUESTED'].includes(contract.status) && (
            <Link to={`/contracts/${contract.id}/edit`} className="text-lsi hover:underline">Éditer le contenu</Link>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/preview.pdf`} target="_blank" rel="noopener" className="text-lsi hover:underline">Aperçu PDF</a>
          )}
          <Link to={`/contracts/${contract.id}/versions`} className="text-lsi hover:underline">Historique</Link>
          {!contract.currentVersionId && <span className="text-gray-400">Aucun contenu rédigé.</span>}
        </div>
      </Card>
```

Vérifier que le type `Detail.contract` de `contract-detail-page.tsx` inclut `id`, `status`, `currentVersionId` — les ajouter au type si absents (la réponse `findOne` renvoie le contrat complet, donc ces champs sont présents à l'exécution ; il faut les déclarer dans l'interface).

Dans `app.tsx`, ajouter `/contracts/:id/versions` (après `/contracts/:id/edit`, avant ou après `/contracts/:id` — les segments statiques priment) :
```tsx
<Route path="/contracts/:id/versions" element={<VersionsPage />} />
```

- [ ] **Step 5 : Lancer, vérifier le succès + suite complète front**

Run: `pnpm --filter @lsi/web test` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS (toute la suite) + typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): bloc Contenu sur la fiche + historique des versions"
```

---

## Clôture

- [ ] **Suites** : `cd apps/api && pnpm exec vitest run` (API, incl. `content-*`) puis `pnpm --filter @lsi/web test` — vert.
- [ ] **CI locale** : `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] **Déploiement** : merger sur `main` → CI → redéployer la stack Portainer 111 (préserver l'env live, relogin si le JWT a expiré). **Aucune migration** dans cet incrément. Vérifier en prod : sur un contrat en brouillon, éditer le contenu, enregistrer, ouvrir l'aperçu PDF, consulter l'historique.
