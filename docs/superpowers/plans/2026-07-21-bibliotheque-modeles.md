# Bibliothèque de modèles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Câbler le stockage des modèles de contrat (déjà modélisé) : CRUD + versions éditables + publication figée + dépréciation, API + écran cockpit.

**Architecture:** `TemplatesController`/`TemplatesService` (`/v1/templates`) miroir de `content.service` (sanitisation + versionnage) ; écran `/templates` (liste + éditeur). Aucune migration.

**Tech Stack:** NestJS (SWC), Prisma + RLS, `withScope`, `sanitizeContractHtml` ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- Toute requête DB via `withScope`. RLS `contract_templates(_versions)_scope` = tenant + non-CLIENT. 404 hors scope.
- Rôles : `assertRole(session, ['MSP_ADMIN','LEGAL_REVIEWER'])` sur TOUS les endpoints.
- `bodyHtml` toujours passé par `sanitizeContractHtml` (de `../documents/html-sanitizer.js`).
- Version DRAFT = `isImmutable:false`, éditée en place ; publication fige (`isImmutable:true`, `publishedAt`, `publishedByUserId`) + `status=PUBLISHED` ; ré-édition après publication → nouvelle version DRAFT (v+1).
- `variablesSchema` (Json) = dérivé des placeholders `{{ nom }}` du corps à chaque enregistrement.
- Publication d'un corps vide → **400**. IDs `uuidv7`. Imports ESM `.js`. Catégories : `MAINTENANCE|SUPPORT|HOSTING|SLA|OTHER`.

---

### Task 1: API — module templates

**Files:**
- Create: `apps/api/src/templates/templates.service.ts`
- Create: `apps/api/src/templates/templates.controller.ts`
- Create: `apps/api/src/templates/dto/create-template.dto.ts`
- Create: `apps/api/src/templates/dto/save-template-content.dto.ts`
- Modify: `apps/api/src/app.module.ts` (controller + provider)
- Test: `apps/api/tests/isolation/templates.test.ts`

**Interfaces:**
- Consumes: `withScope`, `uuidv7`, `type Scope` ; `sanitizeContractHtml` ; `assertRole`, `CurrentScope`, `CurrentSession`.
- Produces: endpoints `/v1/templates*`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/templates.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post'|'put', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

async function newTemplate(name = 'Maintenance standard') {
  const res = await req('sess-admin', 'post', '/v1/templates').send({ name, category: 'MAINTENANCE' }).expect(201);
  return res.body.id as string;
}

describe('bibliothèque de modèles', () => {
  test('création → DRAFT avec une version 1 vide, listée', async () => {
    const id = await newTemplate();
    const detail = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'DRAFT' });
    expect(detail.body.currentVersion.versionNumber).toBe(1);
    expect(detail.body.currentVersion.isImmutable).toBe(false);
    const list = await req('sess-admin', 'get', '/v1/templates').expect(200);
    expect(list.body.items.some((t: any) => t.id === id)).toBe(true);
  });

  test('enregistrement : sanitise + extrait les variables des placeholders', async () => {
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`)
      .send({ bodyHtml: '<p>Client {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>' }).expect(200);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.currentVersion.bodyHtml).not.toContain('<script>');
    const props = d.body.currentVersion.variablesSchema?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['client_nom', 'montant']);
  });

  test('publication fige la version et refuse un corps vide', async () => {
    const empty = await newTemplate();
    await req('sess-admin', 'post', `/v1/templates/${empty}/publish`).expect(400); // corps vide
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>Corps</p>' }).expect(200);
    await req('sess-admin', 'post', `/v1/templates/${id}/publish`).expect(201);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.status).toBe('PUBLISHED');
    expect(d.body.currentVersion.isImmutable).toBe(true);
    expect(d.body.currentVersion.publishedAt).not.toBeNull();
  });

  test('ré-édition après publication crée une nouvelle version DRAFT (v+1)', async () => {
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>v1</p>' }).expect(200);
    await req('sess-admin', 'post', `/v1/templates/${id}/publish`).expect(201);
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>v2</p>' }).expect(200);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.currentVersion.versionNumber).toBe(2);
    expect(d.body.currentVersion.isImmutable).toBe(false);
    expect(d.body.versions.length).toBe(2);
  });

  test('rôle non autorisé (ACCOUNT_MANAGER) → 403 ; modèle inexistant → 404', async () => {
    await req('sess-am', 'get', '/v1/templates').expect(403);
    await req('sess-admin', 'get', '/v1/templates/00000000-0000-7000-8000-000000000000').expect(404);
  });
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- templates`
Expected: FAIL (routes absentes).

- [ ] **Step 3: DTOs**

`apps/api/src/templates/dto/create-template.dto.ts` :

```ts
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;

export class CreateTemplateDto {
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string;

  @IsEnum(CATEGORIES, { message: 'Catégorie invalide.' })
  category!: (typeof CATEGORIES)[number];
}
```

`apps/api/src/templates/dto/save-template-content.dto.ts` :

```ts
import { IsString, MaxLength } from 'class-validator';

export class SaveTemplateContentDto {
  @IsString() @MaxLength(200000)
  bodyHtml!: string;
}
```

- [ ] **Step 4: Service**

`apps/api/src/templates/templates.service.ts` :

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';

/** Extrait les noms de variables `{{ nom }}` d'un corps HTML. */
function extractVariables(html: string): string[] {
  const names = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) names.add(m[1]);
  return [...names].sort();
}
function variablesSchemaOf(names: string[]) {
  const properties: Record<string, { type: 'string' }> = {};
  for (const n of names) properties[n] = { type: 'string' };
  return { type: 'object', properties, required: names };
}

@Injectable()
export class TemplatesService {
  private async load(tx: any, id: string) {
    const t = await tx.contractTemplate.findUnique({
      where: { id },
      select: { id: true, tenantId: true, name: true, category: true, status: true, currentVersionId: true },
    });
    if (!t) throw new NotFoundException('Modèle introuvable');
    return t;
  }

  async list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.contractTemplate.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, category: true, status: true, currentVersionId: true, updatedAt: true, _count: { select: { versions: true } } },
      });
      return { items: rows.map((t: any) => ({ id: t.id, name: t.name, category: t.category, status: t.status, versionCount: t._count.versions, updatedAt: t.updatedAt })) };
    });
  }

  async get(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      const versions = await tx.contractTemplateVersion.findMany({
        where: { templateId: id }, orderBy: { versionNumber: 'asc' },
        select: { id: true, versionNumber: true, isImmutable: true, publishedAt: true, createdAt: true },
      });
      const cur = t.currentVersionId
        ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, versionNumber: true, bodyHtml: true, variablesSchema: true, isImmutable: true, publishedAt: true } })
        : null;
      return { id: t.id, name: t.name, category: t.category, status: t.status, currentVersion: cur, versions };
    });
  }

  async create(scope: Scope, name: string, category: string, now: Date) {
    return withScope(scope, async (tx) => {
      const id = uuidv7();
      const versionId = uuidv7();
      await tx.contractTemplate.create({ data: {
        id, tenantId: scope.tenantId, name, category: category as any, status: 'DRAFT',
        currentVersionId: versionId, createdAt: now, updatedAt: now,
      } });
      await tx.contractTemplateVersion.create({ data: {
        id: versionId, tenantId: scope.tenantId, templateId: id, versionNumber: 1,
        bodyHtml: '', variablesSchema: variablesSchemaOf([]), isImmutable: false, createdAt: now,
      } });
      return { id };
    });
  }

  async saveContent(scope: Scope, id: string, bodyHtml: string, now: Date, userId: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      const clean = sanitizeContractHtml(bodyHtml);
      const schema = variablesSchemaOf(extractVariables(clean));
      const cur = t.currentVersionId
        ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, versionNumber: true, isImmutable: true } })
        : null;
      let version;
      if (cur && !cur.isImmutable) {
        version = await tx.contractTemplateVersion.update({ where: { id: cur.id }, data: { bodyHtml: clean, variablesSchema: schema }, select: { id: true, versionNumber: true } });
      } else {
        const max = await tx.contractTemplateVersion.aggregate({ where: { templateId: id }, _max: { versionNumber: true } });
        version = await tx.contractTemplateVersion.create({ data: {
          id: uuidv7(), tenantId: t.tenantId, templateId: id, versionNumber: (max._max.versionNumber ?? 0) + 1,
          bodyHtml: clean, variablesSchema: schema, isImmutable: false, createdAt: now,
        }, select: { id: true, versionNumber: true } });
      }
      await tx.contractTemplate.update({ where: { id }, data: { currentVersionId: version.id, updatedAt: now, ...(t.status === 'PUBLISHED' ? { status: 'DRAFT' } : {}) } });
      return { versionId: version.id, versionNumber: version.versionNumber };
    });
  }

  async publish(scope: Scope, id: string, now: Date, userId: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      if (!t.currentVersionId) throw new BadRequestException('Aucune version à publier.');
      const cur = await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, bodyHtml: true } });
      if (!cur || cur.bodyHtml.trim() === '') throw new BadRequestException('Corps vide : rien à publier.');
      await tx.contractTemplateVersion.update({ where: { id: cur.id }, data: { isImmutable: true, publishedAt: now, publishedByUserId: userId } });
      await tx.contractTemplate.update({ where: { id }, data: { status: 'PUBLISHED', updatedAt: now } });
      return { ok: true as const };
    });
  }

  async deprecate(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.load(tx, id);
      await tx.contractTemplate.update({ where: { id }, data: { status: 'DEPRECATED', updatedAt: now } });
      return { ok: true as const };
    });
  }
}
```

- [ ] **Step 5: Contrôleur**

`apps/api/src/templates/templates.controller.ts` :

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { TemplatesService } from './templates.service.js';
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { SaveTemplateContentDto } from './dto/save-template-content.dto.js';

const ROLES = ['MSP_ADMIN', 'LEGAL_REVIEWER'] as const;

@Controller('v1/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertRole(s, [...ROLES]); return this.templates.list(scope);
  }

  @Get(':id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.get(scope, id);
  }

  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body() dto: CreateTemplateDto) {
    assertRole(s, [...ROLES]); return this.templates.create(scope, dto.name, dto.category, new Date());
  }

  @Put(':id/content')
  save(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTemplateContentDto) {
    assertRole(s, [...ROLES]); return this.templates.saveContent(scope, id, dto.bodyHtml, new Date(), s.userId);
  }

  @Post(':id/publish')
  publish(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.publish(scope, id, new Date(), s.userId);
  }

  @Post(':id/deprecate')
  deprecate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.deprecate(scope, id, new Date());
  }
}
```

- [ ] **Step 6: Câbler app.module.ts**

Imports :

```ts
import { TemplatesController } from './templates/templates.controller.js';
import { TemplatesService } from './templates/templates.service.js';
```

Ajouter `TemplatesController` aux `controllers`, `TemplatesService` aux `providers`.

- [ ] **Step 7: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- templates`
Expected: PASS (5/5).

- [ ] **Step 8: Non-régression ciblée + lint + typecheck**

Run: `pnpm --filter @lsi/api test -- templates content` puis `pnpm lint` puis `pnpm typecheck`
Expected: PASS partout.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/templates apps/api/src/app.module.ts apps/api/tests/isolation/templates.test.ts
git commit -m "feat(templates): bibliothèque de modèles — CRUD + versions + publication figée + variables extraites"
```

---

### Task 2: Frontend — écran bibliothèque de modèles

**Files:**
- Create: `apps/web/src/features/templates/templates-page.tsx`
- Create: `apps/web/src/features/templates/template-detail-page.tsx`
- Modify: `apps/web/src/app.tsx` (routes `/templates`, `/templates/:id`)
- Modify: `apps/web/src/shell/app-shell.tsx` (lien nav gaté)
- Modify: `apps/web/src/lib/labels.ts` (`templateStatusLabel`, `contractCategoryLabel` si absent)
- Test: `apps/web/src/test/templates-page.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `apiPost`, `apiPut` ; `useMe` (rôle) ; endpoints Task 1.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/templates-page.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TemplatesPage } from '../features/templates/templates-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('affiche la liste des modèles', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 't1', name: 'Maintenance standard', category: 'MAINTENANCE', status: 'PUBLISHED', versionCount: 2, updatedAt: '2026-07-21T10:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<TemplatesPage />);
  await waitFor(() => expect(screen.getByText('Maintenance standard')).toBeInTheDocument());
});

test('« Nouveau modèle » poste puis la liste se rafraîchit', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body = (init?.method === 'POST') ? { id: 'tNew' } : { items: [] };
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<TemplatesPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: /Nouveau modèle/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Nouveau modèle/i }));
  // formulaire minimal : nom + catégorie + valider
  fireEvent.change(screen.getByLabelText(/Nom/i), { target: { value: 'Nouveau' } });
  fireEvent.click(screen.getByRole('button', { name: /Créer/i }));
  await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.includes('/v1/templates'))).toBe(true));
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/web test -- templates-page`
Expected: FAIL (module absent).

- [ ] **Step 3: Libellés**

Dans `apps/web/src/lib/labels.ts`, ajouter si absents :

```ts
export function templateStatusLabel(s: string): string {
  return ({ DRAFT: 'Brouillon', PUBLISHED: 'Publié', DEPRECATED: 'Déprécié' } as Record<string, string>)[s] ?? s;
}
```

*(`contractCategoryLabel` existe déjà — réutiliser.)*

- [ ] **Step 4: Page liste (`templates-page.tsx`)**

Créer `apps/web/src/features/templates/templates-page.tsx` : `useQuery(['templates'])` → `apiGet<{items}>('/v1/templates')`. Tableau (nom lié à `/templates/:id`, catégorie via `contractCategoryLabel`, statut via `templateStatusLabel` + StatusBadge, versionCount). Bouton **Nouveau modèle** ouvrant un petit formulaire (champ `Nom` avec `<label>Nom</label>`, sélecteur de catégorie parmi `MAINTENANCE/SUPPORT/HOSTING/SLA/OTHER`, bouton **Créer**) qui `apiPost('/v1/templates', {name, category})` puis invalide `['templates']` et navigue vers `/templates/:id` du nouveau. Suivre le motif de `contracts-page.tsx`/`users` existant.

- [ ] **Step 5: Page détail (`template-detail-page.tsx`)**

Créer `apps/web/src/features/templates/template-detail-page.tsx` : `useQuery(['template', id])` → `apiGet('/v1/templates/:id')`. Affiche nom, catégorie, statut. **Éditeur** : `<textarea>` pré-rempli avec `currentVersion.bodyHtml`, bouton **Enregistrer** (`apiPut('/v1/templates/:id/content', {bodyHtml})` → invalide `['template', id]`). Boutons **Publier** (`apiPost('.../publish')`, désactivé si `status==='PUBLISHED'` ou corps vide) et **Déprécier** (`apiPost('.../deprecate')`). Liste des versions (n°, publiée le, immuable). Après publication, un nouvel Enregistrer crée visiblement une v+1.

- [ ] **Step 6: Routes + nav**

Dans `apps/web/src/app.tsx` : importer `TemplatesPage`/`TemplateDetailPage`, ajouter routes internes `/templates` et `/templates/:id` (motif des routes internes existantes).

Dans `apps/web/src/shell/app-shell.tsx` : ajouter, sous les autres liens, un lien conditionnel :

```tsx
          {(me.data?.roles?.includes('MSP_ADMIN') || me.data?.roles?.includes('LEGAL_REVIEWER')) && <li><Link to="/templates">Modèles</Link></li>}
```

- [ ] **Step 7: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- templates-page`
Expected: PASS (2/2).

- [ ] **Step 8: Build + lint + typecheck**

Run: `pnpm --filter @lsi/web build` puis `pnpm lint` puis `pnpm typecheck`
Expected: OK partout.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/templates apps/web/src/app.tsx apps/web/src/shell/app-shell.tsx apps/web/src/lib/labels.ts apps/web/src/test/templates-page.test.tsx
git commit -m "feat(web/templates): écran bibliothèque de modèles (liste + création + éditeur + publication)"
```

---

## Self-Review

**Spec coverage :**
- §3 API (list/get/create/save/publish/deprecate, rôles, variables, publish-vide-400) → Task 1 ✅
- §4 front (liste + création + éditeur + publier/déprécier + nav gaté) → Task 2 ✅
- §5 sécurité (403 hors rôle, 404 scope, publish fige, ré-édition v+1) → tests Task 1 + front Task 2 ✅

**Placeholders :** aucun. Task 2 (JSX) décrit précisément les endpoints, gâchettes et query keys ; l'implémenteur assemble en suivant les pages existantes.

**Cohérence des types :** endpoints `/v1/templates*` (contrôleur Task 1) ↔ appels front (Task 2) ; `variablesSchema.properties` consommé par le test API ; `templateStatusLabel` défini avant usage. Réutilise `sanitizeContractHtml` + `contractCategoryLabel` existants.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
