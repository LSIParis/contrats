# Commentaires client↔LSI (§6.10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au client (portail) de commenter un contrat en messages SHARED et à LSI (cockpit) de voir/répondre avec visibilité INTERNAL/SHARED, la cloison étant DB-enforced par la RLS `comments_scope`.

**Architecture:** Un `CommentsService` + `CommentsController` internes (`/v1/contracts/:id/comments`), et des méthodes portail ajoutées à `PortalService` (`/v1/portal/contracts/:id/comments`) qui projettent client-safe, forcent `visibility=SHARED` et créent une `Notification` pour le propriétaire du contrat. Aucune migration : les modèles `Comment`/`Notification` et les policies RLS existent déjà.

**Tech Stack:** NestJS (SWC), Prisma + PostgreSQL RLS, `withScope`, class-validator ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- Toute requête DB passe par `withScope(scope, tx => …)` — jamais de Prisma nu. La RLS fait le tri de visibilité ; le service ne réimplémente pas le filtre.
- Un `Comment` créé côté portail a **toujours** `visibility='SHARED'` (forcé serveur ; le WITH CHECK RLS le garantit aussi).
- IDs applicatifs générés par `uuidv7()` (importé de `@lsi/persistence`) — les modèles `Comment`/`Notification` n'ont pas de `@default`.
- `Comment` requiert : `id, tenantId, customerId, contractId, authorUserId, visibility, body, createdAt, updatedAt`. `authorUserId = scope.userId`. `tenantId`/`customerId` proviennent du contrat chargé sous scope.
- `Notification` requiert : `id, tenantId, recipientUserId, type, subject, body, createdAt` (+ `customerId, relatedContractId, dedupKey` renseignés). `channel` défaut `IN_APP`, `status` défaut `QUEUED`.
- 404 (jamais 403) pour un contrat hors scope / non visible côté portail : message unifié `'Contrat introuvable'`.
- Rôles : commentaire interne (GET+POST) = `['MSP_ADMIN','ACCOUNT_MANAGER','LEGAL_REVIEWER']` via `assertRole(session, [...])`. Portail : toute session CLIENT (garde deny-by-default + RLS).
- Imports ESM avec extension `.js`. Contrôleurs annotés `@Controller('v1/...')`. `@Param('id', ParseUUIDPipe)`.
- Libellés FR dans `apps/web/src/lib/labels.ts`. Fetch portail via `portalGet`/`portalPost` ; cockpit via `apiGet`/`apiPost`.

---

### Task 1: API interne — CommentsService + CommentsController

**Files:**
- Create: `apps/api/src/comments/comments.service.ts`
- Create: `apps/api/src/comments/comments.controller.ts`
- Create: `apps/api/src/comments/dto/create-comment.dto.ts`
- Modify: `apps/api/src/app.module.ts` (déclarer controller + provider)
- Test: `apps/api/tests/isolation/comments-internal.test.ts`

**Interfaces:**
- Consumes: `withScope`, `uuidv7`, `type Scope` de `@lsi/persistence` ; `CurrentScope`, `CurrentSession`, `assertRole` de `../auth/current-scope.decorator.js` ; `type Session` de `../auth/session.service.js`.
- Produces (réutilisés Task 2/4) :
  - `CommentsService.listInternal(scope: Scope, contractId: string): Promise<{ id: string; body: string; visibility: 'INTERNAL'|'SHARED'; author: { fullName: string }; createdAt: Date }[]>`
  - `CommentsService.createInternal(scope: Scope, authorUserId: string, contractId: string, body: string, visibility: 'INTERNAL'|'SHARED', now: Date): Promise<{ id: string }>`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/comments-internal.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedContract(customerId: string, ownerUserId: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId, reference: `LSI-CM-${id.slice(-8)}`,
    title: 'Avec commentaires', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId,
    createdAt: now, updatedAt: now, createdByUserId: ownerUserId, updatedByUserId: ownerUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const asAmA = () => request(app.getHttpServer());

describe('commentaires interne', () => {
  test('POST puis GET rend le commentaire avec sa visibilité et son auteur', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: 'Note interne', visibility: 'INTERNAL' }).expect(201);
    const res = await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ body: 'Note interne', visibility: 'INTERNAL' });
    expect(res.body.items[0].author.fullName).toBeTruthy();
  });

  test('visibilité par défaut = INTERNAL si absente du DTO', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: 'Sans visibilité' }).expect(201);
    const res = await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items[0].visibility).toBe('INTERNAL');
  });

  test('un rôle non autorisé (TECHNICIAN) → 403', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-tech').expect(403);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-tech')
      .send({ body: 'x' }).expect(403);
  });

  test('body vide → 400', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: '' }).expect(400);
  });

  test('contrat hors portefeuille → 404', async () => {
    const id = await seedContract(fx.customerB.id, fx.amBUserId);
    await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
```

- [ ] **Step 2: Lancer le test — échoue (module/route absents)**

Run: `pnpm --filter @lsi/api test -- comments-internal`
Expected: FAIL (404 sur les routes, `items` undefined).

- [ ] **Step 3: Créer le DTO**

`apps/api/src/comments/dto/create-comment.dto.ts` :

```ts
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le commentaire ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Commentaire trop long (5000 caractères max).' })
  body!: string;

  @IsOptional()
  @IsEnum(['INTERNAL', 'SHARED'], { message: 'Visibilité invalide.' })
  visibility?: 'INTERNAL' | 'SHARED';
}
```

- [ ] **Step 4: Créer le service**

`apps/api/src/comments/comments.service.ts` :

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';

@Injectable()
export class CommentsService {
  /** Contrat visible sous le scope courant, sinon 404. Renvoie tenant/customer/owner. */
  private async loadContract(tx: any, contractId: string) {
    const c = await tx.contract.findUnique({
      where: { id: contractId },
      select: { id: true, tenantId: true, customerId: true, ownerUserId: true, status: true },
    });
    if (!c) throw new NotFoundException('Contrat introuvable'); // RLS → 404 hors scope
    return c;
  }

  /** Commentaires visibles (RLS → INTERNAL + SHARED pour un acteur interne). */
  async listInternal(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      await this.loadContract(tx, contractId);
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, visibility: true, createdAt: true, author: { select: { fullName: true } } },
      });
      return rows.map((r: any) => ({
        id: r.id, body: r.body, visibility: r.visibility,
        author: { fullName: r.author.fullName }, createdAt: r.createdAt,
      }));
    });
  }

  async createInternal(scope: Scope, authorUserId: string, contractId: string, body: string, visibility: 'INTERNAL' | 'SHARED', now: Date) {
    return withScope(scope, async (tx) => {
      const c = await this.loadContract(tx, contractId);
      const id = uuidv7();
      await tx.comment.create({ data: {
        id, tenantId: c.tenantId, customerId: c.customerId, contractId,
        authorUserId, visibility, body, createdAt: now, updatedAt: now,
      } });
      return { id };
    });
  }
}
```

- [ ] **Step 5: Créer le contrôleur**

`apps/api/src/comments/comments.controller.ts` :

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';

const COMMENT_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'] as const;

@Controller('v1/contracts')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(':id/comments')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, [...COMMENT_ROLES]);
    const items = await this.comments.listInternal(scope, id);
    return { items };
  }

  @Post(':id/comments')
  async create(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto,
  ) {
    assertRole(session, [...COMMENT_ROLES]);
    return this.comments.createInternal(scope, session.userId, id, dto.body, dto.visibility ?? 'INTERNAL', new Date());
  }
}
```

- [ ] **Step 6: Câbler dans app.module.ts**

Ajouter les imports en tête (près des autres) :

```ts
import { CommentsController } from './comments/comments.controller.js';
import { CommentsService } from './comments/comments.service.js';
```

Ajouter `CommentsController` dans le tableau `controllers` (après `SignersController`) et `CommentsService` dans `providers` (après `SignersService`).

- [ ] **Step 7: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- comments-internal`
Expected: PASS (5/5).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/comments apps/api/src/app.module.ts apps/api/tests/isolation/comments-internal.test.ts
git commit -m "feat(comments): API interne — GET/POST /v1/contracts/:id/comments (RLS INTERNAL+SHARED)"
```

---

### Task 2: API portail — commentaires SHARED + notification propriétaire

**Files:**
- Modify: `apps/api/src/portal/portal.service.ts` (ajouter `listComments`, `createComment`)
- Modify: `apps/api/src/portal/portal-contracts.controller.ts` (routes GET/POST)
- Test: `apps/api/tests/isolation/portal-comments.test.ts`

**Interfaces:**
- Consumes: modèles `Comment`/`Notification`, `withScope`, `uuidv7`, RLS `comments_scope` (CLIENT → SHARED only) et `notifications_scope` (WITH CHECK = tenant + customer_in_scope, recipient non contraint → un CLIENT peut notifier le propriétaire interne).
- Produces:
  - `PortalService.listComments(scope, contractId): Promise<{ id; body; author: { fullName; kind }; createdAt }[]>`
  - `PortalService.createComment(scope, contractId, body: string, now: Date): Promise<{ id: string }>`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/portal-comments.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture; let clientUserId: string;
const CLIENT_EMAIL = 'commenter-a@example.com';

async function seedContract(customerId: string, ownerUserId: string, status = 'ACTIVE') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId, reference: `LSI-PC-${id.slice(-8)}`,
    title: 'Portail commentaires', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId,
    createdAt: now, updatedAt: now, createdByUserId: ownerUserId, updatedByUserId: ownerUserId } }));
  return id;
}
async function seedComment(contractId: string, customerId: string, visibility: 'INTERNAL' | 'SHARED') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
    id, tenantId: fx.tenantId, customerId, contractId, authorUserId: fx.amUserId,
    visibility, body: `corps ${visibility}`, createdAt: now, updatedAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: CLIENT_EMAIL, fullName: 'Client A', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } }));
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId) }, 1800);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const asClient = (m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', 'sess-client');

describe('commentaires portail', () => {
  test('le portail ne voit QUE les commentaires SHARED', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await seedComment(id, fx.customerA.id, 'INTERNAL');
    await seedComment(id, fx.customerA.id, 'SHARED');
    const res = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].body).toBe('corps SHARED');
    expect(JSON.stringify(res.body)).not.toContain('corps INTERNAL');
  });

  test('POST portail crée un commentaire SHARED (visible interne + portail)', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    const post = await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'Bonjour LSI' }).expect(201);
    expect(post.body.id).toBeTruthy();
    // visible côté portail
    const list = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    expect(list.body.items.map((i: any) => i.body)).toContain('Bonjour LSI');
    // créé en SHARED en base
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.comment.findMany({ where: { contractId: id }, select: { visibility: true, authorUserId: true } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visibility: 'SHARED', authorUserId: clientUserId });
  });

  test('un POST portail crée une Notification pour le propriétaire du contrat', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'Merci de rappeler' }).expect(201);
    const notifs = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.notification.findMany({ where: { relatedContractId: id }, select: { recipientUserId: true, type: true } }));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ recipientUserId: fx.amUserId, type: 'CLIENT_COMMENT' });
  });

  test('contrat d’un autre client (IDOR) → 404 en lecture comme en écriture', async () => {
    const id = await seedContract(fx.customerB.id, fx.amBUserId);
    await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(404);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'x' }).expect(404);
  });

  test('body vide → 400', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: '' }).expect(400);
  });
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/api test -- portal-comments`
Expected: FAIL (routes absentes → 404 partout, `items` undefined).

- [ ] **Step 3: Ajouter les méthodes à PortalService**

Dans `apps/api/src/portal/portal.service.ts`, importer `uuidv7` (ajouter à l'import existant `{ withScope, type Scope }` → `{ withScope, uuidv7, type Scope }`) puis ajouter dans la classe :

```ts
  /** Commentaires visibles du portail (RLS → SHARED uniquement pour un CLIENT). */
  async listComments(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true, status: true } });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable');
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, author: { select: { fullName: true, kind: true } } },
      });
      return rows.map((r: any) => ({
        id: r.id, body: r.body,
        author: { fullName: r.author.fullName, kind: r.author.kind },
        createdAt: r.createdAt,
      }));
    });
  }

  /** Le client publie un message SHARED + notifie le propriétaire du contrat. */
  async createComment(scope: Scope, contractId: string, body: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, status: true, tenantId: true, customerId: true, ownerUserId: true, reference: true },
      });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable');
      const id = uuidv7();
      await tx.comment.create({ data: {
        id, tenantId: c.tenantId, customerId: c.customerId, contractId,
        authorUserId: scope.userId, visibility: 'SHARED', body, createdAt: now, updatedAt: now,
      } });
      // Notification pour le propriétaire. Le WITH CHECK notifications_scope
      // n'exige que tenant + customer_in_scope → une session CLIENT peut créer
      // une notification destinée à l'utilisateur interne propriétaire.
      await tx.notification.create({ data: {
        id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId,
        recipientUserId: c.ownerUserId, type: 'CLIENT_COMMENT',
        subject: `Nouveau message client — ${c.reference}`,
        body, relatedContractId: contractId,
        dedupKey: `client-comment:${id}`, createdAt: now,
      } });
      return { id };
    });
  }
```

- [ ] **Step 4: Ajouter les routes au contrôleur portail**

Dans `apps/api/src/portal/portal-contracts.controller.ts`, ajouter `Body`, `Post` aux imports `@nestjs/common` et une DTO + deux routes :

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
```

```ts
class PortalCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le message ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Message trop long (5000 caractères max).' })
  body!: string;
}
```

Puis dans la classe :

```ts
  @Get('contracts/:id/comments')
  async listComments(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    const items = await this.portal.listComments(scope, id);
    return { items };
  }

  @Post('contracts/:id/comments')
  createComment(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PortalCommentDto) {
    return this.portal.createComment(scope, id, dto.body, new Date());
  }
```

- [ ] **Step 5: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- portal-comments`
Expected: PASS (5/5).

- [ ] **Step 6: Non-régression du module portail**

Run: `pnpm --filter @lsi/api test -- portal`
Expected: PASS (portal-comments + portal-sign + portal-contracts).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/portal apps/api/tests/isolation/portal-comments.test.ts
git commit -m "feat(portail): commentaires SHARED + notification propriétaire au message client"
```

---

### Task 3: Frontend portail — fil de commentaires + boutons de demande

**Files:**
- Modify: `apps/web/src/portal/portal-contract-page.tsx`
- Modify: `apps/web/src/lib/labels.ts` (ajouter `commentAuthorLabel`)
- Test: `apps/web/src/test/portal-comments.test.tsx`

**Interfaces:**
- Consumes: `portalGet`, `portalPost` de `./portal-api.js` ; endpoints Task 2 `GET/POST /v1/portal/contracts/:id/comments`.
- Produces: bloc « Échanges avec LSI » dans la fiche portail.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/portal-comments.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PortalContractPage } from '../portal/portal-contract-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/portal/contracts/c1']}>
        <Routes><Route path="/portal/contracts/:id" element={<PortalContractPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const detail = { id: 'c1', reference: 'LSI-2026-0001', title: 'Maintenance', status: 'ACTIVE', category: 'MAINTENANCE', startDate: null, endDate: null, amountCents: null, currency: null, billingFrequency: null, signers: [], mySignature: null };

test('la fiche portail affiche les commentaires SHARED', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/comments')) return new Response(JSON.stringify({ items: [{ id: 'm1', body: 'Réponse LSI', author: { fullName: 'Sylvie M.', kind: 'INTERNAL' }, createdAt: '2026-07-21T10:00:00Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Réponse LSI')).toBeInTheDocument());
});

test('le bouton « Demander un renouvellement » pré-remplit la zone de saisie', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/comments')) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Demander un renouvellement/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Demander un renouvellement/ }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toMatch(/renouveler/i);
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/web test -- portal-comments`
Expected: FAIL (bloc commentaires + bouton absents).

- [ ] **Step 3: Ajouter le libellé auteur**

Dans `apps/web/src/lib/labels.ts`, ajouter :

```ts
export function commentAuthorLabel(kind: string): string {
  return kind === 'CLIENT' ? 'Vous' : 'LSI';
}
```

- [ ] **Step 4: Étendre la fiche portail**

Dans `apps/web/src/portal/portal-contract-page.tsx` :

Remplacer les imports d'en-tête par :

```tsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { portalGet, portalPost, PortalUnauthorized } from './portal-api.js';
import { Spinner } from '../ui/spinner.js';
import { Card } from '../ui/card.js';
import { StatusBadge } from '../ui/badge.js';
import { contractCategoryLabel, partyLabel, signerStatusLabel, commentAuthorLabel } from '../lib/labels.js';
```

Ajouter, après l'interface `PortalContractDetail`, le type des commentaires :

```tsx
interface PortalComment {
  id: string;
  body: string;
  author: { fullName: string; kind: string };
  createdAt: string;
}

const RENEW_PREFILL = 'Bonjour, je souhaite renouveler ce contrat. Merci de me recontacter.';
const TERMINATE_PREFILL = 'Bonjour, je souhaite résilier ce contrat. Merci de me recontacter.';

function CommentsCard({ contractId }: { contractId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const comments = useQuery({
    queryKey: ['portal-comments', contractId],
    queryFn: () => portalGet<{ items: PortalComment[] }>(`/v1/portal/contracts/${contractId}/comments`),
    retry: false,
  });
  const send = useMutation({
    mutationFn: (body: string) => portalPost(`/v1/portal/contracts/${contractId}/comments`, { body }),
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['portal-comments', contractId] }); },
  });
  const items = comments.data?.items ?? [];
  return (
    <Card title="Échanges avec LSI">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun message pour le moment.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {items.map((m) => (
            <li key={m.id} className="text-sm">
              <div className="font-medium">{commentAuthorLabel(m.author.kind)} <span className="text-gray-400">· {new Date(m.createdAt).toLocaleDateString('fr-FR')}</span></div>
              <div className="whitespace-pre-wrap text-gray-700">{m.body}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => setDraft(RENEW_PREFILL)} className="rounded border border-lsi px-3 py-1 text-xs text-lsi hover:bg-lsi/10">Demander un renouvellement</button>
        <button type="button" onClick={() => setDraft(TERMINATE_PREFILL)} className="rounded border border-lsi px-3 py-1 text-xs text-lsi hover:bg-lsi/10">Demander une résiliation</button>
      </div>
      <textarea
        value={draft} onChange={(e) => setDraft(e.target.value)}
        rows={3} placeholder="Écrire un message à LSI…"
        className="w-full rounded border border-gray-300 p-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button" disabled={!draft.trim() || send.isPending}
          onClick={() => send.mutate(draft.trim())}
          className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50"
        >Envoyer</button>
        {send.isError && <span className="text-sm text-red-600">Envoi impossible.</span>}
      </div>
    </Card>
  );
}
```

Enfin, insérer `<CommentsCard contractId={id!} />` dans le rendu de `PortalContractPage`, juste après la `<Card title="Signataires">…</Card>` (avant la fermeture `</div>`).

- [ ] **Step 5: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- portal-comments`
Expected: PASS (2/2).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/portal/portal-contract-page.tsx apps/web/src/lib/labels.ts apps/web/src/test/portal-comments.test.tsx
git commit -m "feat(web/portail): fil de commentaires SHARED + boutons demande renouvellement/résiliation"
```

---

### Task 4: Frontend cockpit — section commentaires avec visibilité

**Files:**
- Create: `apps/web/src/features/contracts/comments-block.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (importer + rendre le bloc)
- Modify: `apps/web/src/lib/labels.ts` (ajouter `commentVisibilityLabel`)
- Test: `apps/web/src/test/comments-block.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `apiPost` de `../../lib/api.js` ; endpoints Task 1 `GET/POST /v1/contracts/:id/comments`.
- Produces: composant `CommentsBlock({ contractId })`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/comments-block.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CommentsBlock } from '../features/contracts/comments-block.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CommentsBlock contractId="c1" /></QueryClientProvider>);
}

test('distingue visuellement INTERNAL et SHARED', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 'm1', body: 'Note interne', visibility: 'INTERNAL', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T10:00:00Z' },
    { id: 'm2', body: 'Visible client', visibility: 'SHARED', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T11:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Note interne')).toBeInTheDocument());
  expect(screen.getByText('Interne')).toBeInTheDocument();
  expect(screen.getByText('Partagé client')).toBeInTheDocument();
});

test('choisir SHARED affiche un avertissement « visible du client »', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByLabelText(/Partagé client/)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText(/Partagé client/));
  expect(screen.getByText(/visible du client/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/web test -- comments-block`
Expected: FAIL (module absent).

- [ ] **Step 3: Ajouter le libellé de visibilité**

Dans `apps/web/src/lib/labels.ts`, ajouter :

```ts
export function commentVisibilityLabel(visibility: string): string {
  return visibility === 'SHARED' ? 'Partagé client' : 'Interne';
}
```

- [ ] **Step 4: Créer le composant**

`apps/web/src/features/contracts/comments-block.tsx` :

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api.js';
import { Card } from '../../ui/card.js';
import { Button } from '../../ui/button.js';
import { commentVisibilityLabel } from '../../lib/labels.js';

interface Comment {
  id: string;
  body: string;
  visibility: 'INTERNAL' | 'SHARED';
  author: { fullName: string };
  createdAt: string;
}

export function CommentsBlock({ contractId }: { contractId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState<'INTERNAL' | 'SHARED'>('INTERNAL');
  const q = useQuery({
    queryKey: ['comments', contractId],
    queryFn: () => apiGet<{ items: Comment[] }>(`/v1/contracts/${contractId}/comments`),
  });
  const send = useMutation({
    mutationFn: (payload: { body: string; visibility: 'INTERNAL' | 'SHARED' }) =>
      apiPost(`/v1/contracts/${contractId}/comments`, payload),
    onSuccess: () => { setDraft(''); setVisibility('INTERNAL'); qc.invalidateQueries({ queryKey: ['comments', contractId] }); },
  });
  const items = q.data?.items ?? [];
  return (
    <Card title="Commentaires">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun commentaire.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {items.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.author.fullName}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${c.visibility === 'SHARED' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                  {commentVisibilityLabel(c.visibility)}
                </span>
                <span className="text-gray-400">· {new Date(c.createdAt).toLocaleDateString('fr-FR')}</span>
              </div>
              <div className="whitespace-pre-wrap text-gray-700">{c.body}</div>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
        placeholder="Ajouter un commentaire…"
        className="w-full rounded border border-gray-300 p-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" name="visibility" checked={visibility === 'INTERNAL'} onChange={() => setVisibility('INTERNAL')} /> Interne
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" name="visibility" checked={visibility === 'SHARED'} onChange={() => setVisibility('SHARED')} /> Partagé client
        </label>
        <Button disabled={!draft.trim() || send.isPending} onClick={() => send.mutate({ body: draft.trim(), visibility })}>
          Publier
        </Button>
      </div>
      {visibility === 'SHARED' && (
        <p className="mt-2 text-sm text-amber-700">⚠ Ce commentaire sera visible du client dans son portail.</p>
      )}
      {send.isError && <p className="mt-2 text-sm text-red-600">Publication impossible.</p>}
    </Card>
  );
}
```

- [ ] **Step 5: Rendre le bloc dans la fiche cockpit**

Dans `apps/web/src/features/contracts/contract-detail-page.tsx` : ajouter l'import `import { CommentsBlock } from './comments-block.js';` (près des autres imports de blocs) et insérer `<CommentsBlock contractId={contract.id} />` dans le JSX rendu, après le bloc `<Timeline …/>` (ou en fin de colonne de détail).

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- comments-block`
Expected: PASS (2/2).

- [ ] **Step 7: Vérifier build + typecheck web**

Run: `pnpm --filter @lsi/web build`
Expected: build OK (pas d'erreur TS).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/contracts/comments-block.tsx apps/web/src/features/contracts/contract-detail-page.tsx apps/web/src/lib/labels.ts apps/web/src/test/comments-block.test.tsx
git commit -m "feat(web/cockpit): section commentaires (INTERNAL/SHARED) + avertissement partage client"
```

---

## Self-Review

**Spec coverage :**
- §3.1 portail GET/POST + notification → Task 2 ✅
- §3.2 interne GET/POST + rôles → Task 1 ✅
- §4.1 portail (fil SHARED + boutons demande) → Task 3 ✅
- §4.2 cockpit (INTERNAL/SHARED + confirmation SHARED) → Task 4 ✅
- §5 sécurité DB-enforced (INTERNAL invisible portail, SHARED cross-visible, IDOR, POST force SHARED, notification créée, rôle 403) → tests Task 1 + Task 2 ✅

**Placeholders :** aucun — chaque étape porte le code complet.

**Cohérence des types :** `listInternal`/`createInternal` (Task 1) et `listComments`/`createComment` (Task 2) ; `commentVisibilityLabel`/`commentAuthorLabel` définis en Task 3/4 avant usage ; endpoints `/v1/contracts/:id/comments` (interne) et `/v1/portal/contracts/:id/comments` (portail) cohérents entre back et front. `Comment.create` renseigne les champs requis du schéma (`id, tenantId, customerId, contractId, authorUserId, visibility, body, createdAt, updatedAt`) ; `Notification.create` renseigne `subject` (requis) + `dedupKey` unique.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development** (pattern établi cette session).
