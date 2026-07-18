# Phase E — Cockpit interne (frontend, incrément 1) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer un cockpit interne en lecture seule (dashboard des échéances, liste et fiche contrat) servi en même origine par l'API, adossé à six endpoints de lecture scopés.

**Architecture:** SPA React/Vite dans un nouveau workspace `apps/web`, buildée et servie en statique par NestJS (`@nestjs/serve-static`). Le front appelle `/v1/*` avec le cookie de session `__Host-` (même origine) ; un 401 renvoie vers `/v1/auth/login`. Toute décision d'autorisation reste côté API (ScopeGuard + RLS) ; le front n'affiche que ce que l'API scopée renvoie.

**Tech Stack:** NestJS 10, Prisma 5, React 18, Vite 5, React Router 6, TanStack Query 5, Tailwind 3, Radix UI, Vitest + Testing Library, supertest, Testcontainers.

## Global Constraints

- **Monorepo pnpm** ; le front est le workspace `@lsi/web` sous `apps/web`. Node 22, pnpm 9.15.9.
- **Runtime API en SWC** (`@swc-node/register`), jamais tsx (pas de métadonnées de décorateurs). Vitest utilise `unplugin-swc`.
- **Sécurité non négociable** : tout nouvel endpoint est scopé par le `ScopeGuard` global (aucun `@Public()`), renvoie **404 (jamais 403) hors scope** (RM-30), et reçoit des tests d'isolation + IDOR (deux clients disjoints). Le front ne porte aucune autorisation.
- **UI en français.**
- **CI** (`pnpm lint` + `pnpm typecheck` + `pnpm test`) doit rester verte, workspace `apps/web` inclus. Interdit : `$queryRawUnsafe`/`$executeRawUnsafe` hors `packages/persistence/src/testing` (règle ESLint §13.3).
- **Pattern de test API** (imposé, cf. `apps/api/tests/isolation/idor.test.ts`) : `SessionService.put({ sessionId, userId, tenantId, roles, scope })` avec `internalScope(tenantId, [customerIds], userId)` / `adminScope(tenantId, userId)` ; requête authentifiée par l'en-tête `x-lsi-session: <sessionId>`.

---

## Structure de fichiers

**API (ajouts)**
- `apps/api/src/auth/me.controller.ts` — `GET /v1/auth/me`
- `apps/api/src/read/dashboard.service.ts` + `dashboard.controller.ts` — `GET /v1/dashboard`
- `apps/api/src/read/reminders.service.ts` + `reminders.controller.ts` — `GET /v1/reminders`
- `apps/api/src/contracts/contracts.service.ts` (modif) — recherche `q`, `findOne` enrichi, `signedDocumentUrl`
- `apps/api/src/contracts/contracts.controller.ts` (modif) — `GET :id/signed-document`
- `apps/api/src/app.module.ts` (modif) — enregistrer les nouveaux contrôleurs/services + `ServeStaticModule`

**Front (`apps/web`)**
- `apps/web/{package.json, index.html, vite.config.ts, tailwind.config.ts, postcss.config.js, tsconfig.json, vitest.config.ts}`
- `apps/web/src/{main.tsx, app.tsx, index.css}`
- `apps/web/src/lib/{api.ts, queries.ts}`
- `apps/web/src/ui/{button.tsx, badge.tsx, card.tsx, table.tsx, spinner.tsx}`
- `apps/web/src/shell/{app-shell.tsx, require-auth.tsx, login.tsx}`
- `apps/web/src/features/dashboard/{dashboard-page.tsx, expiring.tsx}`
- `apps/web/src/features/contracts/{contracts-page.tsx, contract-detail-page.tsx, signature-block.tsx, reminders-block.tsx, timeline.tsx}`
- `apps/web/src/test/*.test.tsx`

**Déploiement**
- `Dockerfile` (modif) — étape de build front + copie du `dist`

---

## Task 1 : `GET /v1/auth/me`

**Files:**
- Create: `apps/api/src/auth/me.controller.ts`
- Modify: `apps/api/src/app.module.ts` (ajouter `MeController` aux `controllers`)
- Test: `apps/api/tests/isolation/me.test.ts`

**Interfaces:**
- Consumes: `@CurrentScope() scope: Scope`, `@CurrentSession() session: Session` (déjà existants dans `apps/api/src/auth/`), `withScope` de `@lsi/persistence`.
- Produces: `GET /v1/auth/me` → `{ userId, fullName, email, kind, roles, tenantId, customerId? }`.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/me.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, clientScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am',
    userId: fx.amUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  await sessions.put({
    sessionId: 'sess-client',
    userId: fx.customerA.clientUserId,
    tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'],
    scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId),
  });
});

describe('GET /v1/auth/me', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).get('/v1/auth/me').expect(401);
  });

  test('utilisateur interne : identité + rôles', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-lsi-session', 'sess-am')
      .expect(200);
    expect(res.body.userId).toBe(fx.amUserId);
    expect(res.body.email).toBe(fx.amEmail);
    expect(res.body.kind).toBe('INTERNAL');
    expect(res.body.roles).toContain('ACCOUNT_MANAGER');
    expect(res.body.customerId ?? null).toBeNull();
  });

  test('utilisateur client : customerId épinglé', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-lsi-session', 'sess-client')
      .expect(200);
    expect(res.body.kind).toBe('CLIENT');
    expect(res.body.customerId).toBe(fx.customerA.id);
  });
});
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/me.test.ts`
Expected: FAIL (404 sur `/v1/auth/me`).

- [ ] **Step 3 : Implémenter le contrôleur**

```typescript
// apps/api/src/auth/me.controller.ts
import { Controller, Get } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { CurrentScope } from './current-scope.decorator.js';
import { CurrentSession } from './current-session.decorator.js';
import type { Session } from './session.service.js';

@Controller('v1/auth')
export class MeController {
  @Get('me')
  async me(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    const user = await withScope(scope, (tx) =>
      tx.user.findFirst({
        where: { id: session.userId },
        select: { fullName: true, email: true, kind: true, customerId: true },
      }),
    );
    return {
      userId: session.userId,
      tenantId: session.tenantId,
      roles: session.roles,
      fullName: user?.fullName ?? null,
      email: user?.email ?? null,
      kind: user?.kind ?? null,
      customerId: user?.customerId ?? null,
    };
  }
}
```

Vérifier les noms exacts des décorateurs dans `apps/api/src/auth/` (`current-scope.decorator.ts`, `current-session.decorator.ts`) et le champ `kind`/`customerId` sur le modèle `User` (`packages/persistence/prisma/schema.prisma`). Ajuster les imports si besoin.

- [ ] **Step 4 : Enregistrer le contrôleur**

Dans `apps/api/src/app.module.ts`, importer `MeController` et l'ajouter au tableau `controllers`.

- [ ] **Step 5 : Lancer le test, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/me.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/auth/me.controller.ts apps/api/src/app.module.ts apps/api/tests/isolation/me.test.ts
git commit -m "feat(api): GET /v1/auth/me — identité de session pour la coquille front"
```

---

## Task 2 : recherche `q` dans `GET /v1/contracts`

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (méthode `list`)
- Test: `apps/api/tests/isolation/contracts-search.test.ts`

**Interfaces:**
- Consumes: `ListContractsDto` (champ `q?: string` déjà déclaré mais non implémenté).
- Produces: `list()` filtre sur `reference`/`title` (insensible à la casse) quand `q` est fourni. Réponse inchangée : `{ data, pagination: { nextCursor, hasMore } }`.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/contracts-search.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-admin',
    userId: fx.adminUserId,
    tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'],
    scope: adminScope(fx.tenantId, fx.adminUserId),
  });
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id,
        reference: 'LSI-CHERCHE-XYZ', title: 'Sauvegarde datacenter', type: 'MAIN',
        status: 'DRAFT', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, createdAt: now, updatedAt: now,
        createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    }),
  );
});

describe('GET /v1/contracts?q=', () => {
  test('la recherche filtre sur la référence', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=CHERCHE')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data.some((c: any) => c.reference === 'LSI-CHERCHE-XYZ')).toBe(true);
  });

  test('la recherche filtre sur le titre', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=datacenter')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data.some((c: any) => c.title === 'Sauvegarde datacenter')).toBe(true);
  });

  test('une recherche sans correspondance renvoie vide', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=zzz-introuvable-zzz')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/contracts-search.test.ts`
Expected: FAIL (le 3e test échoue : `q` non implémenté, tout est renvoyé).

- [ ] **Step 3 : Implémenter le filtre `q`**

Dans `apps/api/src/contracts/contracts.service.ts`, méthode `list`, après le bloc `if (q.cursor) …` et avant `tx.contract.findMany`, ajouter :

```typescript
      if (q.q?.trim()) {
        where.OR = [
          { reference: { contains: q.q.trim(), mode: 'insensitive' } },
          { title: { contains: q.q.trim(), mode: 'insensitive' } },
        ];
      }
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/contracts-search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/contracts/contracts.service.ts apps/api/tests/isolation/contracts-search.test.ts
git commit -m "feat(api): recherche q (référence/titre) dans GET /v1/contracts"
```

---

## Task 3 : `GET /v1/dashboard`

**Files:**
- Create: `apps/api/src/read/dashboard.service.ts`, `apps/api/src/read/dashboard.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/dashboard.test.ts`

**Interfaces:**
- Consumes: `@CurrentScope() scope`, `withScope`.
- Produces: `GET /v1/dashboard` → `{ countsByStatus: Record<string, number>, expiring: { j30, j60, j90 }, pendingReminders: number }`. Chaque bucket `jNN` est un `ContractCard[]` = `{ id, reference, title, customerName, status, endDate }`. `j30` ⊆ échéance ≤ 30 j, `j60` = ]30, 60], `j90` = ]60, 90] (fenêtres disjointes), contrats `ACTIVE` uniquement.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/dashboard.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, withScope, adminScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
const DAY = 86_400_000;

async function activeContract(customerId: string, endInDays: number) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId,
        reference: `LSI-${id.slice(-8)}`, title: 'Contrat', type: 'MAIN',
        status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, startDate: new Date(now.getTime() - 300 * DAY),
        endDate: new Date(now.getTime() + endInDays * DAY),
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    }),
  );
  return id;
}

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
  await activeContract(fx.customerA.id, 20); // j30 de A
  await activeContract(fx.customerA.id, 50); // j60 de A
  await activeContract(fx.customerB.id, 20); // j30 de B — NE DOIT PAS apparaître pour l'AM de A
});

describe('GET /v1/dashboard', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).get('/v1/dashboard').expect(401);
  });

  test('les échéances sont scopées au portefeuille', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/dashboard')
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    // AM de A voit ses 2 contrats ACTIVE (j30 + j60), jamais celui de B.
    const all = [...res.body.expiring.j30, ...res.body.expiring.j60, ...res.body.expiring.j90];
    expect(all).toHaveLength(2);
    expect(res.body.expiring.j30).toHaveLength(1);
    expect(res.body.expiring.j60).toHaveLength(1);
    expect(res.body.countsByStatus.ACTIVE).toBe(2); // pas 3 : B est hors scope
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/dashboard.test.ts`
Expected: FAIL (404).

- [ ] **Step 3 : Implémenter le service**

```typescript
// apps/api/src/read/dashboard.service.ts
import { Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

interface ContractCard {
  id: string; reference: string; title: string;
  customerName: string; status: string; endDate: Date | null;
}

@Injectable()
export class DashboardService {
  async build(scope: Scope, now: Date) {
    return withScope(scope, async (tx) => {
      const grouped = await tx.contract.groupBy({ by: ['status'], _count: { _all: true } });
      const countsByStatus: Record<string, number> = {};
      for (const g of grouped) countsByStatus[g.status] = g._count._all;

      const in90 = new Date(now.getTime() + 90 * 86_400_000);
      const expiringRows = await tx.contract.findMany({
        where: { status: 'ACTIVE', endDate: { not: null, lte: in90 } },
        orderBy: { endDate: 'asc' },
        include: { customer: { select: { name: true } } },
      });

      const buckets: { j30: ContractCard[]; j60: ContractCard[]; j90: ContractCard[] } = {
        j30: [], j60: [], j90: [],
      };
      for (const c of expiringRows) {
        const days = Math.ceil((c.endDate!.getTime() - now.getTime()) / 86_400_000);
        const card: ContractCard = {
          id: c.id, reference: c.reference, title: c.title,
          customerName: c.customer.name, status: c.status, endDate: c.endDate,
        };
        if (days <= 30) buckets.j30.push(card);
        else if (days <= 60) buckets.j60.push(card);
        else buckets.j90.push(card);
      }

      const pendingReminders = await tx.reminder.count({ where: { status: 'PENDING' } });

      return { countsByStatus, expiring: buckets, pendingReminders };
    });
  }
}
```

- [ ] **Step 4 : Implémenter le contrôleur**

```typescript
// apps/api/src/read/dashboard.controller.ts
import { Controller, Get } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { DashboardService } from './dashboard.service.js';

@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  build(@CurrentScope() scope: Scope) {
    return this.dashboard.build(scope, new Date());
  }
}
```

- [ ] **Step 5 : Enregistrer**

Dans `app.module.ts` : ajouter `DashboardController` aux `controllers` et `DashboardService` aux `providers`.

- [ ] **Step 6 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 7 : Commit**

```bash
git add apps/api/src/read/dashboard.service.ts apps/api/src/read/dashboard.controller.ts apps/api/src/app.module.ts apps/api/tests/isolation/dashboard.test.ts
git commit -m "feat(api): GET /v1/dashboard — agrégats d'échéance scopés (§6.1)"
```

---

## Task 4 : `GET /v1/contracts/:id` enrichi

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (`findOne`)
- Test: `apps/api/tests/isolation/contract-detail.test.ts`

**Interfaces:**
- Produces: `findOne` renvoie `{ contract, customer, signatureRequest, reminders, timeline }`.
  - `signatureRequest`: `{ status, signers: [{ party, fullName, status, signedAt }] } | null`
  - `reminders`: `[{ kind, offsetDays, dueAt, status, sentAt, late }]`
  - `timeline`: `[{ at: Date, type: string, label: string }]` trié par `at` croissant, fusion des jalons du contrat (`createdAt`, `signedAt`, `activatedAt`) et des `signature_events`.
- Le contrôleur `GET :id` existant renvoie déjà le résultat de `findOne` ; sa signature ne change pas.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/contract-detail.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let contractId: string;

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
  await sessions.put({
    sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId),
  });

  contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id,
        reference: 'LSI-DETAIL-1', title: 'Contrat détail', type: 'MAIN',
        status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, signedAt: now, activatedAt: now,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.contractSigner.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId,
        party: 'CLIENT', fullName: 'J. Dupont', email: 'jd@dupont.fr',
        signingOrder: 1, status: 'SIGNED', signedAt: now, createdAt: now, updatedAt: now,
      },
    });
    await tx.reminder.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId,
        kind: 'EXPIRY', offsetDays: 30, cycle: 0, dueAt: now, status: 'PENDING', createdAt: now,
      },
    });
  });
});

describe('GET /v1/contracts/:id enrichi', () => {
  test('renvoie contrat, signataires, rappels et timeline', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${contractId}`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    expect(res.body.contract.reference).toBe('LSI-DETAIL-1');
    expect(res.body.customer.name).toBeTruthy();
    expect(res.body.signatureRequest?.signers ?? []).toBeInstanceOf(Array);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.timeline.length).toBeGreaterThanOrEqual(1);
  });

  test('IDOR : l’AM de B reçoit 404, jamais 403', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${contractId}`)
      .set('x-lsi-session', 'sess-am-b')
      .expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/contract-detail.test.ts`
Expected: FAIL (réponse plate : `res.body.contract` est `undefined`).

- [ ] **Step 3 : Enrichir `findOne`**

Remplacer le corps de `findOne` dans `contracts.service.ts` par :

```typescript
  async findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        include: { customer: { select: { id: true, name: true } } },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');

      const sigReq = await tx.signatureRequest.findFirst({
        where: { contractId: id },
        orderBy: { createdAt: 'desc' },
      });
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id },
        orderBy: { signingOrder: 'asc' },
        select: { party: true, fullName: true, status: true, signedAt: true },
      });
      const reminders = await tx.reminder.findMany({
        where: { contractId: id },
        orderBy: { offsetDays: 'desc' },
        select: { kind: true, offsetDays: true, dueAt: true, status: true, sentAt: true, late: true },
      });
      // signature_events n'a PAS de contract_id — on relie par la demande de
      // signature (vérifié dans le schéma).
      const events = sigReq
        ? await tx.signatureEvent.findMany({
            where: { signatureRequestId: sigReq.id },
            orderBy: { occurredAt: 'asc' },
            select: { eventType: true, occurredAt: true, submitterEmail: true },
          })
        : [];

      const timeline = [
        c.createdAt && { at: c.createdAt, type: 'CREATED', label: 'Contrat créé' },
        c.signedAt && { at: c.signedAt, type: 'SIGNED', label: 'Signé' },
        c.activatedAt && { at: c.activatedAt, type: 'ACTIVATED', label: 'Activé' },
        ...events.map((e) => ({
          at: e.occurredAt, type: e.eventType,
          label: `${e.eventType}${e.submitterEmail ? ` — ${e.submitterEmail}` : ''}`,
        })),
      ]
        .filter((x): x is { at: Date; type: string; label: string } => Boolean(x))
        .sort((a, b) => a.at.getTime() - b.at.getTime());

      return {
        contract: c,
        customer: c.customer,
        signatureRequest: sigReq ? { status: sigReq.status, signers } : null,
        reminders,
        timeline,
      };
    });
  }
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/contract-detail.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5 : Vérifier la non-régression des autres consommateurs de `findOne`**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/idor.test.ts`
Expected: PASS (le contrat de la fiche est maintenant sous `contract`, adapter si un test lisait la forme plate — sinon rien à faire).

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts/contracts.service.ts apps/api/tests/isolation/contract-detail.test.ts
git commit -m "feat(api): fiche contrat enrichie (signataires, rappels, timeline)"
```

---

## Task 5 : `GET /v1/reminders`

**Files:**
- Create: `apps/api/src/read/reminders.service.ts`, `apps/api/src/read/reminders.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/reminders-list.test.ts`

**Interfaces:**
- Produces: `GET /v1/reminders?status=PENDING` → `{ items: [{ id, contractId, contractReference, kind, offsetDays, dueAt, status, late }], total }`. Scopé ; `status` optionnel.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/reminders-list.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

async function reminderFor(customerId: string, contractRef: string) {
  const contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId, tenantId: fx.tenantId, customerId, reference: contractRef,
        title: 'C', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
        currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.reminder.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId, contractId,
        kind: 'EXPIRY', offsetDays: 30, cycle: 0, dueAt: now, status: 'PENDING', createdAt: now,
      },
    });
  });
}

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
  await reminderFor(fx.customerA.id, 'LSI-REM-A');
  await reminderFor(fx.customerB.id, 'LSI-REM-B');
});

describe('GET /v1/reminders', () => {
  test('scopé : l’AM de A ne voit que les rappels de A', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reminders?status=PENDING')
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    const refs = res.body.items.map((r: any) => r.contractReference);
    expect(refs).toContain('LSI-REM-A');
    expect(refs).not.toContain('LSI-REM-B');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/reminders-list.test.ts`
Expected: FAIL (404).

- [ ] **Step 3 : Implémenter service + contrôleur**

```typescript
// apps/api/src/read/reminders.service.ts
import { Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

@Injectable()
export class RemindersReadService {
  async list(scope: Scope, status?: string) {
    return withScope(scope, async (tx) => {
      const rows = await tx.reminder.findMany({
        where: status ? { status: status as never } : {},
        orderBy: { dueAt: 'asc' },
        include: { contract: { select: { reference: true } } },
      });
      const items = rows.map((r) => ({
        id: r.id, contractId: r.contractId, contractReference: r.contract.reference,
        kind: r.kind, offsetDays: r.offsetDays, dueAt: r.dueAt, status: r.status, late: r.late,
      }));
      return { items, total: items.length };
    });
  }
}
```

```typescript
// apps/api/src/read/reminders.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { RemindersReadService } from './reminders.service.js';

@Controller('v1/reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersReadService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @Query('status') status?: string) {
    return this.reminders.list(scope, status);
  }
}
```

Enregistrer `RemindersController` (controllers) et `RemindersReadService` (providers) dans `app.module.ts`.

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/reminders-list.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/read/reminders.service.ts apps/api/src/read/reminders.controller.ts apps/api/src/app.module.ts apps/api/tests/isolation/reminders-list.test.ts
git commit -m "feat(api): GET /v1/reminders — liste scopée des rappels"
```

---

## Task 6 : `GET /v1/contracts/:id/signed-document`

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (nouvelle méthode `signedDocumentUrl`), `apps/api/src/contracts/contracts.controller.ts` (route), le constructeur du service pour injecter `DOCUMENT_STORAGE`
- Test: `apps/api/tests/isolation/signed-document.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_STORAGE` + `assertKeyMatchesScope` + type `ObjectScope` de `apps/api/src/documents/document-storage.port.js`. Signatures réelles (vérifiées) : `assertKeyMatchesScope(key: string, scope: { tenantId: string; customerId: string })` — exige les DEUX (le préfixe attendu est `t/{tenantId}/c/{customerId}/`) ; `DocumentStorage.presignedGetUrl(key: string, scope: ObjectScope, ttlSeconds: number): Promise<string>`. `InMemoryStorage.presignedGetUrl` valide le scope puis renvoie `memory://{key}` sans exiger que l'objet existe (le test passe donc sans `put` préalable).
- Produces: `GET /v1/contracts/:id/signed-document` → `{ url: string }`. 404 si contrat hors scope OU sans `signedPdfObjectKey`.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/signed-document.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let withProof: string;
let withoutProof: string;

async function contract(customerId: string, signedKey: string | null): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId, reference: `LSI-${id.slice(-8)}`,
        title: 'C', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
        currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.signatureRequest.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId, contractId: id, versionId: uuidv7(),
        provider: 'DOCUSEAL', status: 'COMPLETED', idempotencyKey: uuidv7(),
        signedPdfObjectKey: signedKey, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId,
      },
    });
  });
  return id;
}

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
  withProof = await contract(
    fx.customerA.id,
    `t/${fx.tenantId}/c/${fx.customerA.id}/contracts/x/signed/y/document.pdf`,
  );
  withoutProof = await contract(fx.customerA.id, null);
});

describe('GET /v1/contracts/:id/signed-document', () => {
  test('preuve présente → { url }', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${withProof}/signed-document`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url.length).toBeGreaterThan(0);
  });

  test('pas de preuve → 404', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${withoutProof}/signed-document`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signed-document.test.ts`
Expected: FAIL (404 partout : route absente).

- [ ] **Step 3 : Injecter le stockage et ajouter la méthode**

Dans `contracts.service.ts`, ajouter au constructeur l'injection du stockage (garder les paramètres existants) :

```typescript
import { Inject } from '@nestjs/common';
import { DOCUMENT_STORAGE, type DocumentStorage, assertKeyMatchesScope } from '../documents/document-storage.port.js';
// … dans le constructeur, ajouter :
//   @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
```

Puis la méthode. On récupère la clé ET le scope objet (tenant + customer) depuis la
`signature_request`, puis on construit l'`ObjectScope` attendu par le stockage :

```typescript
  async signedDocumentUrl(scope: Scope, id: string): Promise<{ url: string }> {
    const found = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) return null; // hors scope : RLS a déjà filtré → 404
      const sr = await tx.signatureRequest.findFirst({
        where: { contractId: id, signedPdfObjectKey: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { signedPdfObjectKey: true, tenantId: true, customerId: true },
      });
      return sr?.signedPdfObjectKey ? { key: sr.signedPdfObjectKey, tenantId: sr.tenantId, customerId: sr.customerId } : null;
    });
    if (!found) throw new NotFoundException('Aucune preuve signée disponible');

    const objScope = { tenantId: found.tenantId, customerId: found.customerId };
    assertKeyMatchesScope(found.key, objScope); // refuse une clé hors du scope
    const url = await this.storage.presignedGetUrl(found.key, objScope, 300); // TTL 5 min
    return { url };
  }
```

Dans `contracts.controller.ts`, ajouter la route :

```typescript
  @Get(':id/signed-document')
  signedDocument(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.contracts.signedDocumentUrl(scope, id);
  }
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signed-document.test.ts`
Expected: PASS (2 tests). En test, `DOCUMENT_STORAGE` = `InMemoryStorage` (pas de `S3_ACCESS_KEY`), dont `presignedGetUrl` renvoie une URL factice non vide.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/contracts/contracts.service.ts apps/api/src/contracts/contracts.controller.ts apps/api/tests/isolation/signed-document.test.ts
git commit -m "feat(api): GET /v1/contracts/:id/signed-document — URL présignée scopée"
```

---

## Task 7 : Scaffolding du workspace `apps/web`

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.js`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/app.tsx`, `apps/web/src/index.css`, `apps/web/src/test/smoke.test.tsx`
- Modify: `pnpm-workspace.yaml` (vérifier que `apps/*` est déjà couvert)

**Interfaces:**
- Produces: workspace `@lsi/web` avec `build`, `dev`, `test` ; `pnpm --filter @lsi/web test` vert.

- [ ] **Step 1 : Vérifier la couverture du workspace**

Run: `grep -n "apps" pnpm-workspace.yaml`
Expected: une ligne `- 'apps/*'`. Sinon, l'ajouter.

- [ ] **Step 2 : Créer `apps/web/package.json`**

```json
{
  "name": "@lsi/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.2",
    "@radix-ui/react-dropdown-menu": "^2.1.2",
    "@tanstack/react-query": "^5.59.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 3 : Créer la config**

```jsonc
// apps/web/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "Bundler", "jsx": "react-jsx", "strict": true,
    "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

```typescript
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // En dev, l'API tourne sur 3001 ; on proxifie /v1 pour rester same-origin.
    proxy: { '/v1': 'http://localhost:3001', '/health': 'http://localhost:3001' },
  },
  build: { outDir: 'dist' },
});
```

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { globals: true, environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
```

```typescript
// apps/web/tailwind.config.ts
import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { lsi: { DEFAULT: '#0b5cad', dark: '#083f79' } }, // couleurs LSI (ajustables)
    },
  },
  plugins: [],
} satisfies Config;
```

```javascript
// apps/web/postcss.config.js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```html
<!-- apps/web/index.html -->
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LSI Contrats</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```css
/* apps/web/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4 : Créer le bootstrap et un composant fumée**

```typescript
// apps/web/src/test/setup.ts
import '@testing-library/jest-dom/vitest';
```

```tsx
// apps/web/src/app.tsx
export function App() {
  return <div>LSI Contrats</div>;
}
```

```tsx
// apps/web/src/main.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

```tsx
// apps/web/src/test/smoke.test.tsx
import { render, screen } from '@testing-library/react';
import { App } from '../app.js';

test('la coquille rend le titre', () => {
  render(<App />);
  expect(screen.getByText('LSI Contrats')).toBeInTheDocument();
});
```

- [ ] **Step 5 : Installer et tester**

Run: `pnpm install && pnpm --filter @lsi/web test`
Expected: PASS (1 test). Puis `pnpm --filter @lsi/web build` → un `dist/` est produit.

- [ ] **Step 6 : Commit**

```bash
git add apps/web pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(web): scaffolding SPA React/Vite (@lsi/web) + Tailwind"
```

---

## Task 8 : Client API + coquille authentifiée

**Files:**
- Create: `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, `apps/web/src/shell/{require-auth.tsx, login.tsx, app-shell.tsx}`, `apps/web/src/ui/{spinner.tsx, button.tsx}`
- Modify: `apps/web/src/app.tsx`, `apps/web/src/main.tsx`
- Test: `apps/web/src/test/require-auth.test.tsx`

**Interfaces:**
- Produces:
  - `api.get<T>(path: string): Promise<T>` — `fetch` same-origin ; sur 401 lève `Unauthorized`.
  - `useMe()` — hook TanStack Query sur `/v1/auth/me`.
  - `<RequireAuth>` — affiche `<Login>` si 401, un spinner en chargement, sinon les enfants.
  - `<AppShell>` — nav + en-tête user, `<Outlet/>`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/require-auth.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireAuth } from '../shell/require-auth.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('un 401 affiche l’écran de connexion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  wrap(<RequireAuth><div>secret</div></RequireAuth>);
  await waitFor(() =>
    expect(screen.getByText(/Se connecter avec Microsoft 365/i)).toBeInTheDocument(),
  );
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test('authentifié : le contenu protégé s’affiche', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ userId: 'u1', fullName: 'Sylvie', roles: ['ACCOUNT_MANAGER'] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  wrap(<RequireAuth><div>secret</div></RequireAuth>);
  await waitFor(() => expect(screen.getByText('secret')).toBeInTheDocument());
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/require-auth.test.tsx`
Expected: FAIL (module `require-auth` absent).

- [ ] **Step 3 : Implémenter le client et la coquille**

```typescript
// apps/web/src/lib/api.ts
export class Unauthorized extends Error {}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`API ${res.status} sur ${path}`);
  return res.json() as Promise<T>;
}

export function login(): void {
  window.location.href = '/v1/auth/login';
}
```

```typescript
// apps/web/src/lib/queries.ts
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api.js';

export interface Me {
  userId: string; fullName: string | null; email: string | null;
  kind: 'INTERNAL' | 'CLIENT' | null; roles: string[]; customerId: string | null;
}
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => apiGet<Me>('/v1/auth/me'), retry: false });
}
```

```tsx
// apps/web/src/ui/spinner.tsx
export function Spinner() {
  return <div className="p-8 text-center text-gray-500">Chargement…</div>;
}
```

```tsx
// apps/web/src/ui/button.tsx
import type { ButtonHTMLAttributes } from 'react';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
```

```tsx
// apps/web/src/shell/login.tsx
import { Button } from '../ui/button.js';
import { login } from '../lib/api.js';
export function Login() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold text-lsi">LSI Contrats</h1>
      <Button onClick={login}>Se connecter avec Microsoft 365</Button>
    </div>
  );
}
```

```tsx
// apps/web/src/shell/require-auth.tsx
import type { ReactNode } from 'react';
import { useMe } from '../lib/queries.js';
import { Unauthorized } from '../lib/api.js';
import { Login } from './login.js';
import { Spinner } from '../ui/spinner.js';

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (me.error instanceof Unauthorized || !me.data) return <Login />;
  return <>{children}</>;
}
```

```tsx
// apps/web/src/shell/app-shell.tsx
import { Link, Outlet } from 'react-router-dom';
import { useMe } from '../lib/queries.js';

export function AppShell() {
  const me = useMe();
  return (
    <div className="flex min-h-screen">
      <nav className="w-56 bg-lsi-dark p-4 text-white">
        <div className="mb-6 font-semibold">LSI Contrats</div>
        <ul className="space-y-2">
          <li><Link to="/dashboard">Tableau de bord</Link></li>
          <li><Link to="/contracts">Contrats</Link></li>
          <li><Link to="/reminders">Rappels</Link></li>
        </ul>
      </nav>
      <div className="flex-1">
        <header className="flex justify-end border-b p-3 text-sm text-gray-600">
          {me.data?.fullName} · {me.data?.roles?.join(', ')}
        </header>
        <main className="p-6"><Outlet /></main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4 : Câbler le routeur et le QueryClient**

```tsx
// apps/web/src/app.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from './shell/require-auth.js';
import { AppShell } from './shell/app-shell.js';

export function App() {
  return (
    <BrowserRouter>
      <RequireAuth>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<div>Tableau de bord</div>} />
            <Route path="/contracts" element={<div>Contrats</div>} />
            <Route path="/reminders" element={<div>Rappels</div>} />
          </Route>
        </Routes>
      </RequireAuth>
    </BrowserRouter>
  );
}
```

```tsx
// apps/web/src/main.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app.js';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

Le test fumée `smoke.test.tsx` teste désormais un `App` avec routeur ; le remplacer par un rendu de `AppShell` ou le supprimer au profit de `require-auth.test.tsx`. Supprimer `smoke.test.tsx`.

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test`
Expected: PASS (les 2 tests de `require-auth`).

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src && git rm apps/web/src/test/smoke.test.tsx
git commit -m "feat(web): client API + coquille authentifiée (401 → login M365)"
```

---

## Task 9 : Écran tableau de bord

**Files:**
- Create: `apps/web/src/features/dashboard/{dashboard-page.tsx, expiring.tsx}`, `apps/web/src/ui/{card.tsx, badge.tsx}`
- Modify: `apps/web/src/lib/queries.ts` (ajouter `useDashboard`), `apps/web/src/app.tsx` (route)
- Test: `apps/web/src/test/expiring.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, TanStack Query.
- Produces: `useDashboard()`, `<ExpiringColumns data={…}/>` (rend J-30/J-60/J-90), `<DashboardPage/>`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/expiring.test.tsx
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { ExpiringColumns } from '../features/dashboard/expiring.js';

const data = {
  j30: [{ id: 'a', reference: 'LSI-A', title: 'T', customerName: 'Dupont', status: 'ACTIVE', endDate: '2026-08-01' }],
  j60: [],
  j90: [],
};

test('affiche les contrats du bucket J-30 avec un lien vers la fiche', () => {
  render(<MemoryRouter><ExpiringColumns data={data as never} /></MemoryRouter>);
  expect(screen.getByText('LSI-A')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /LSI-A/ })).toHaveAttribute('href', '/contracts/a');
});

test('un bucket vide affiche un état vide', () => {
  render(<MemoryRouter><ExpiringColumns data={data as never} /></MemoryRouter>);
  expect(screen.getAllByText(/Aucun contrat/i).length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/expiring.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter**

```tsx
// apps/web/src/ui/card.tsx
import type { ReactNode } from 'react';
export function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      {children}
    </section>
  );
}
```

```tsx
// apps/web/src/ui/badge.tsx
const COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800', DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_SIGNATURE: 'bg-amber-100 text-amber-800', EXPIRED: 'bg-red-100 text-red-800',
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
}
```

```tsx
// apps/web/src/features/dashboard/expiring.tsx
import { Link } from 'react-router-dom';
import { Card } from '../../ui/card.js';

export interface ContractCard {
  id: string; reference: string; title: string;
  customerName: string; status: string; endDate: string | null;
}
export interface ExpiringData { j30: ContractCard[]; j60: ContractCard[]; j90: ContractCard[]; }

function Column({ label, items }: { label: string; items: ContractCard[] }) {
  return (
    <Card title={label}>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun contrat</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id}>
              <Link to={`/contracts/${c.id}`} className="block hover:underline">
                <span className="font-medium">{c.reference}</span>
                <span className="text-gray-500"> — {c.customerName}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ExpiringColumns({ data }: { data: ExpiringData }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Column label="Expire sous 30 jours" items={data.j30} />
      <Column label="31 à 60 jours" items={data.j60} />
      <Column label="61 à 90 jours" items={data.j90} />
    </div>
  );
}
```

```tsx
// apps/web/src/features/dashboard/dashboard-page.tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';
import { ExpiringColumns, type ExpiringData } from './expiring.js';

interface Dashboard {
  countsByStatus: Record<string, number>;
  expiring: ExpiringData;
  pendingReminders: number;
}

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => apiGet<Dashboard>('/v1/dashboard') });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Erreur de chargement.</p>;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tableau de bord</h1>
      <ExpiringColumns data={q.data.expiring} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Object.entries(q.data.countsByStatus).map(([status, n]) => (
          <Link key={status} to={`/contracts?status=${status}`}>
            <Card title={status}><div className="text-3xl font-bold">{n}</div></Card>
          </Link>
        ))}
        <Card title="Rappels en attente">
          <div className="text-3xl font-bold">{q.data.pendingReminders}</div>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 4 : Brancher la route**

Dans `app.tsx`, remplacer `<Route path="/dashboard" element={<div>Tableau de bord</div>} />` par `<Route path="/dashboard" element={<DashboardPage />} />` (importer `DashboardPage`).

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/expiring.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): écran tableau de bord — échéances J-30/60/90 + compteurs"
```

---

## Task 10 : Écran liste des contrats

**Files:**
- Create: `apps/web/src/features/contracts/contracts-page.tsx`, `apps/web/src/ui/table.tsx`
- Modify: `apps/web/src/app.tsx` (route)
- Test: `apps/web/src/test/contracts-page.test.tsx`

**Interfaces:**
- Produces: `<ContractsPage/>` — table (référence, titre, client, statut, échéance), filtre statut + recherche, pagination curseur via le bouton « Charger plus ». Lit `?status=` de l'URL (venant du dashboard).

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/contracts-page.test.tsx
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { ContractsPage } from '../features/contracts/contracts-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts']}>
        <ContractsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche les contrats renvoyés par l’API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({
      data: [{ id: 'c1', reference: 'LSI-1', title: 'Maintenance', customer: { name: 'Dupont' }, status: 'ACTIVE', endDate: '2026-09-01' }],
      pagination: { nextCursor: null, hasMore: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  wrap();
  await waitFor(() => expect(screen.getByText('LSI-1')).toBeInTheDocument());
  expect(screen.getByText('Dupont')).toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/contracts-page.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter**

```tsx
// apps/web/src/ui/table.tsx
import type { ReactNode } from 'react';
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="border-b text-left text-gray-500">{head}</thead>
      <tbody>{children}</tbody>
    </table>
  );
}
```

```tsx
// apps/web/src/features/contracts/contracts-page.tsx
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { StatusBadge } from '../../ui/badge.js';

interface Row {
  id: string; reference: string; title: string;
  customer: { name: string }; status: string; endDate: string | null;
}
interface ListResponse { data: Row[]; pagination: { nextCursor: string | null; hasMore: boolean }; }

export function ContractsPage() {
  const [params] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');

  const query = useQuery({
    queryKey: ['contracts', status, q],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
      if (q.trim()) sp.set('q', q.trim());
      return apiGet<ListResponse>(`/v1/contracts?${sp.toString()}`);
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Contrats</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher (référence, titre)…"
        className="w-72 rounded border px-3 py-1.5 text-sm"
      />
      {query.isLoading ? (
        <Spinner />
      ) : query.error || !query.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : query.data.data.length === 0 ? (
        <p className="text-gray-400">Aucun contrat.</p>
      ) : (
        <Table head={<tr><th className="py-2">Référence</th><th>Titre</th><th>Client</th><th>Statut</th><th>Échéance</th></tr>}>
          {query.data.data.map((c) => (
            <tr key={c.id} className="border-b hover:bg-gray-50">
              <td className="py-2"><Link to={`/contracts/${c.id}`} className="text-lsi hover:underline">{c.reference}</Link></td>
              <td>{c.title}</td>
              <td>{c.customer.name}</td>
              <td><StatusBadge status={c.status} /></td>
              <td>{c.endDate ? new Date(c.endDate).toLocaleDateString('fr-FR') : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : Brancher la route**

Dans `app.tsx`, remplacer la route `/contracts` par `<Route path="/contracts" element={<ContractsPage />} />`.

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/contracts-page.test.tsx`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): écran liste des contrats (filtre statut + recherche)"
```

---

## Task 11 : Écran fiche contrat

**Files:**
- Create: `apps/web/src/features/contracts/{contract-detail-page.tsx, signature-block.tsx, reminders-block.tsx, timeline.tsx}`
- Modify: `apps/web/src/app.tsx` (route `/contracts/:id`)
- Test: `apps/web/src/test/signature-block.test.tsx`

**Interfaces:**
- Produces: `<ContractDetailPage/>` (lit `:id`), sous-composants `<SignatureBlock/>`, `<RemindersBlock/>`, `<Timeline/>`, et un bouton « Télécharger le signé » qui appelle `/v1/contracts/:id/signed-document` et ouvre l'URL.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/signature-block.test.tsx
import { render, screen } from '@testing-library/react';
import { SignatureBlock } from '../features/contracts/signature-block.js';

test('rend chaque signataire avec son statut', () => {
  render(
    <SignatureBlock
      data={{ status: 'COMPLETED', signers: [
        { party: 'LSI', fullName: 'Marc D.', status: 'SIGNED', signedAt: '2026-07-01' },
        { party: 'CLIENT', fullName: 'J. Dupont', status: 'SENT', signedAt: null },
      ] }}
    />,
  );
  expect(screen.getByText('Marc D.')).toBeInTheDocument();
  expect(screen.getByText('J. Dupont')).toBeInTheDocument();
  expect(screen.getByText(/SIGNED/)).toBeInTheDocument();
  expect(screen.getByText(/SENT/)).toBeInTheDocument();
});

test('sans demande de signature, affiche un état vide', () => {
  render(<SignatureBlock data={null} />);
  expect(screen.getByText(/Aucune demande de signature/i)).toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/signature-block.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter les sous-composants**

```tsx
// apps/web/src/features/contracts/signature-block.tsx
import { Card } from '../../ui/card.js';

export interface Signer { party: string; fullName: string; status: string; signedAt: string | null; }
export interface SignatureData { status: string; signers: Signer[]; }

export function SignatureBlock({ data }: { data: SignatureData | null }) {
  return (
    <Card title="Signature">
      {!data ? (
        <p className="text-sm text-gray-400">Aucune demande de signature.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {data.signers.map((s, i) => (
            <li key={i} className="flex justify-between">
              <span>{s.fullName} <span className="text-gray-400">({s.party})</span></span>
              <span className="font-medium">{s.status}{s.signedAt ? ` · ${new Date(s.signedAt).toLocaleDateString('fr-FR')}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

```tsx
// apps/web/src/features/contracts/reminders-block.tsx
import { Card } from '../../ui/card.js';
export interface Reminder { kind: string; offsetDays: number; dueAt: string; status: string; late: boolean; }
export function RemindersBlock({ reminders }: { reminders: Reminder[] }) {
  return (
    <Card title="Rappels">
      {reminders.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun rappel.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {reminders.map((r, i) => (
            <li key={i} className="flex justify-between">
              <span>J-{r.offsetDays} · {new Date(r.dueAt).toLocaleDateString('fr-FR')}</span>
              <span className={r.late ? 'text-red-600' : 'text-gray-600'}>{r.status}{r.late ? ' (retard)' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

```tsx
// apps/web/src/features/contracts/timeline.tsx
import { Card } from '../../ui/card.js';
export interface Event { at: string; type: string; label: string; }
export function Timeline({ events }: { events: Event[] }) {
  return (
    <Card title="Historique">
      <ol className="space-y-1 text-sm">
        {events.map((e, i) => (
          <li key={i}><span className="text-gray-400">{new Date(e.at).toLocaleString('fr-FR')}</span> — {e.label}</li>
        ))}
      </ol>
    </Card>
  );
}
```

```tsx
// apps/web/src/features/contracts/contract-detail-page.tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { StatusBadge } from '../../ui/badge.js';
import { SignatureBlock, type SignatureData } from './signature-block.js';
import { RemindersBlock, type Reminder } from './reminders-block.js';
import { Timeline, type Event } from './timeline.js';

interface Detail {
  contract: { reference: string; title: string; status: string; startDate: string | null; endDate: string | null };
  customer: { name: string };
  signatureRequest: SignatureData | null;
  reminders: Reminder[];
  timeline: Event[];
}

async function downloadSigned(id: string) {
  const { url } = await apiGet<{ url: string }>(`/v1/contracts/${id}/signed-document`);
  window.open(url, '_blank', 'noopener');
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Contrat introuvable.</p>;
  const { contract, customer } = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{contract.reference} — {contract.title}</h1>
          <p className="text-gray-500">{customer.name} · <StatusBadge status={contract.status} /></p>
          <p className="text-sm text-gray-400">
            {contract.startDate ? new Date(contract.startDate).toLocaleDateString('fr-FR') : '—'}
            {' → '}
            {contract.endDate ? new Date(contract.endDate).toLocaleDateString('fr-FR') : '—'}
          </p>
        </div>
        <Button onClick={() => id && downloadSigned(id)}>Télécharger le signé</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SignatureBlock data={q.data.signatureRequest} />
        <RemindersBlock reminders={q.data.reminders} />
      </div>
      <Timeline events={q.data.timeline} />
    </div>
  );
}
```

- [ ] **Step 4 : Brancher la route**

Dans `app.tsx`, ajouter `<Route path="/contracts/:id" element={<ContractDetailPage />} />` (importer le composant).

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/signature-block.test.tsx`
Expected: PASS (2 tests). Puis `pnpm --filter @lsi/web test` (toute la suite front) et `pnpm --filter @lsi/web typecheck` → verts.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): fiche contrat (signature, rappels, timeline, téléchargement du signé)"
```

---

## Task 12 : Service statique NestJS + build front dans l'image

**Files:**
- Modify: `apps/api/src/app.module.ts` (`ServeStaticModule`), `apps/api/package.json` (dépendance `@nestjs/serve-static`), `Dockerfile`
- Test: `apps/api/tests/isolation/serve-static.test.ts`

**Interfaces:**
- Produces: l'API sert le SPA sur les routes non-`/v1` / non-`/health` ; `/v1/*` et `/health` ne sont JAMAIS capturés par le repli SPA.

- [ ] **Step 1 : Installer la dépendance**

Run: `pnpm --filter @lsi/api add @nestjs/serve-static`
Expected: `@nestjs/serve-static` ajouté à `apps/api/package.json`.

- [ ] **Step 2 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/serve-static.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

let app: INestApplication;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});

describe('service statique', () => {
  test('les routes /v1 ne sont pas capturées par le repli SPA', async () => {
    // Sans session → 401 (le guard répond), PAS 200 avec de l’HTML.
    const res = await request(app.getHttpServer()).get('/v1/contracts');
    expect(res.status).toBe(401);
  });

  test('/health reste public et JSON', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
```

- [ ] **Step 3 : Lancer, vérifier qu'il passe déjà (garde-fou)**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/serve-static.test.ts`
Expected: PASS (avant même le ServeStatic — ce test protège contre une future régression où le repli avalerait `/v1`).

- [ ] **Step 4 : Ajouter `ServeStaticModule`**

Dans `apps/api/src/app.module.ts`, ajouter aux imports du décorateur `@Module` :

```typescript
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
// … dans @Module({ imports: [ … ] }) :
    ServeStaticModule.forRoot({
      // Le bundle Vite ; en dev il peut être absent (Vite sert lui-même) —
      // ServeStatic renvoie alors 404 sur les routes SPA, ce qui est sans effet
      // puisque le dev passe par le serveur Vite (proxy /v1 → 3001).
      rootPath: join(process.cwd(), 'apps/web/dist'),
      // JAMAIS capturer l'API ni le healthcheck avec le repli index.html.
      exclude: ['/v1/{*path}', '/health'],
    }),
```

(Si `AppModule` n'a pas encore de bloc `imports`, l'ajouter. Vérifier la syntaxe `exclude` supportée par la version installée : selon la version, utiliser `'/v1*'` et `'/health'`. Adapter jusqu'à ce que le test de l'étape 3 reste vert.)

- [ ] **Step 5 : Lancer, vérifier la non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/serve-static.test.ts`
Expected: PASS (2 tests) — `/v1/contracts` renvoie toujours 401, pas d'HTML.

- [ ] **Step 6 : Étendre le Dockerfile (build front + copie)**

Modifier `Dockerfile` :

1. Étape `deps` — ajouter le manifeste front avant `pnpm install` :
```dockerfile
COPY apps/web/package.json ./apps/web/
```

2. Étape `build` — après `prisma generate`, builder le front :
```dockerfile
RUN pnpm --filter @lsi/web build
```

L'étape `runtime` fait déjà `COPY --from=build /app ./`, donc `apps/web/dist` est inclus. `ServeStaticModule` lit `process.cwd()/apps/web/dist` = `/app/apps/web/dist`. Rien d'autre à changer (même port 3001, même liaison WireGuard).

- [ ] **Step 7 : Vérifier le build d'image localement**

Run: `docker build -t lsi-contrats:phase-e .`
Expected: build OK ; l'étape `pnpm --filter @lsi/web build` produit `apps/web/dist`.

- [ ] **Step 8 : Commit**

```bash
git add apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml Dockerfile apps/api/tests/isolation/serve-static.test.ts
git commit -m "feat(deploy): NestJS sert le SPA (même origine) + build front dans l'image"
```

---

## Clôture

- [ ] **Suite complète** : `cd apps/api && pnpm exec vitest run` (API) puis `pnpm --filter @lsi/web test` (front) — tout vert.
- [ ] **CI locale** : depuis la racine, `pnpm lint && pnpm typecheck && pnpm test` — vert (le workspace `apps/web` est couvert par `pnpm -r`).
- [ ] **Déploiement** : pousser sur `main` → CI construit l'image (build front inclus) → redéployer la stack Portainer 111 (préserver l'env live, cf. mémoire `redeploy-portainer`). Vérifier `https://contrats.lsi-maintenance.fr/` sert le cockpit et que le login M365 mène au dashboard.
