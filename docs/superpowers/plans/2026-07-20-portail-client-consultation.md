# Portail client — Consultation — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Un client se connecte (magic link existant) et consulte ses contrats (liste + fiche, lecture seule, projection client-safe), avec une garde qui interdit à une session CLIENT tout ce qui n'est pas `/v1/portal/*`.

**Architecture:** Module portail (`apps/api/src/portal/`) avec `PortalContractsController`/`PortalService` (projections client-safe sous RLS) ; `ClientPortalGuard` global (deny-by-default) ; `verify` redirige vers l'app ; zone frontend `/portal/*` (layout + auth propres).

**Tech Stack:** NestJS 10, Prisma 5, React 18, React Router 6, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité (H11, §6.15)** : le portail est **lecture seule** ; projection **client-safe** (jamais approbations/timeline/commentaires/rappels) ; une session `actorKind='CLIENT'` ne peut atteindre QUE `/v1/portal/*` (+ auth `@Public()`). RLS borne au `customerId` du client.
- Contrats visibles au client : statut **∉ {DRAFT, IN_REVIEW, CHANGES_REQUESTED, APPROVED}**.
- `Scope.actorKind` ∈ {'INTERNAL','CLIENT','SYSTEM'} ; la session est posée sur `req.session` par le `ScopeGuard`. Le magic link pointe sur `/v1/portal/auth/verify` (base = `APP_URL`).
- Pattern de test API : `SessionService.put` + `x-lsi-session` ; `seedTwoCustomers` ; scope client via `clientScope(tenantId, customerId, userId)` de `@lsi/persistence`. Le SPA fallback sert déjà `/portal/*`.

---

## Structure de fichiers

- Create: `apps/api/src/portal/portal.service.ts`, `apps/api/src/portal/portal-contracts.controller.ts`, `apps/api/src/portal/client-portal.guard.ts`
- Modify: `apps/api/src/app.module.ts` (controllers + provider + APP_GUARD), `apps/api/src/auth/portal-auth.controller.ts` (verify redirige)
- Test: `apps/api/tests/isolation/portal-contracts.test.ts`, `apps/api/tests/isolation/client-portal-guard.test.ts`
- Create (front): `apps/web/src/portal/portal-app.tsx`, `portal-layout.tsx`, `portal-login-page.tsx`, `portal-contracts-page.tsx`, `portal-contract-page.tsx`, `apps/web/src/portal/portal-api.ts`
- Modify: `apps/web/src/app.tsx` (zone `/portal/*`)
- Test: `apps/web/src/test/portal-contracts-page.test.tsx`

---

## Task 1 : API portail (contrats client-safe) + verify redirige

**Files:** `portal.service.ts`, `portal-contracts.controller.ts`, `app.module.ts`, `portal-auth.controller.ts`, `portal-contracts.test.ts`.

**Interfaces:**
- Produces: `GET /v1/portal/contracts`, `GET /v1/portal/contracts/:id`, `GET /v1/portal/me` (client-safe). `verify` → 302 vers `/portal/contracts`.

- [ ] **Step 1 : test qui échoue**

```typescript
// apps/api/tests/isolation/portal-contracts.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let clientUserId: string;

async function seedContract(status: string, cid?: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: cid ?? fx.customerA.id, reference: `LSI-PORT-${id.slice(-8)}`,
    title: 'Contrat client', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(90000), ownerUserId: fx.amUserId,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  // Un utilisateur CLIENT rattaché au customerA (kind CLIENT).
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: 'client-a@example.com', fullName: 'Nathalie Client', status: 'ACTIVE',
    createdAt: new Date(), updatedAt: new Date() } }));
  await app.get(SessionService).put({
    sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_VIEWER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId),
  }, 1800);
});

const get = (path: string, sess = 'sess-client') => request(app.getHttpServer()).get(path).set('x-lsi-session', sess);

describe('GET /v1/portal/contracts', () => {
  test('liste les contrats partagés du client, sans les états internes', async () => {
    await seedContract('ACTIVE');
    await seedContract('DRAFT'); // interne, ne doit PAS apparaître
    const res = await get('/v1/portal/contracts').expect(200);
    const statuses = res.body.items.map((c: any) => c.status);
    expect(statuses).toContain('ACTIVE');
    expect(statuses).not.toContain('DRAFT');
    // projection client-safe : pas de champ interne
    expect(res.body.items[0]).not.toHaveProperty('approval');
    expect(res.body.items[0]).toHaveProperty('reference');
  });

  test('fiche : champs client-safe + signataires, aucun champ interne', async () => {
    const id = await seedContract('ACTIVE');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contractSigner.create({ data: {
      id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT',
      fullName: 'Nathalie Client', email: 'client-a@example.com', signingOrder: 1, status: 'SIGNED',
      signedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } }));
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body).toMatchObject({ reference: expect.any(String), status: 'ACTIVE' });
    expect(res.body.signers[0]).toMatchObject({ party: 'CLIENT', status: 'SIGNED' });
    expect(res.body).not.toHaveProperty('approval');
    expect(res.body).not.toHaveProperty('timeline');
    expect(res.body).not.toHaveProperty('reminders');
  });

  test('un contrat interne (DRAFT) du client → 404 côté portail', async () => {
    const id = await seedContract('DRAFT');
    await get(`/v1/portal/contracts/${id}`).expect(404);
  });

  test('IDOR : contrat du customerB → 404', async () => {
    const id = await seedContract('ACTIVE', fx.customerB.id);
    await get(`/v1/portal/contracts/${id}`).expect(404);
  });

  test('GET /v1/portal/me → email + nom du client', async () => {
    const res = await get('/v1/portal/me').expect(200);
    expect(res.body).toMatchObject({ email: 'client-a@example.com' });
    expect(res.body.customerName).toBeTruthy();
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : service + contrôleur**

```typescript
// apps/api/src/portal/portal.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

const HIDDEN = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED']; // états internes non partagés

@Injectable()
export class PortalService {
  private base(c: any) {
    return {
      id: c.id, reference: c.reference, title: c.title, status: c.status, category: c.category,
      startDate: c.startDate, endDate: c.endDate, amountCents: c.amountCents, currency: c.currency,
      billingFrequency: c.billingFrequency,
    };
  }

  async list(scope: Scope) {
    const rows = await withScope(scope, (tx) => tx.contract.findMany({
      where: { status: { notIn: HIDDEN as any } },
      orderBy: { createdAt: 'desc' },
    }));
    return { items: rows.map((c) => this.base(c)) };
  }

  async findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id } });
      if (!c || HIDDEN.includes(c.status)) throw new NotFoundException('Contrat introuvable'); // RLS 404 hors scope ; 404 si non partagé
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id }, orderBy: { signingOrder: 'asc' },
        select: { party: true, fullName: true, status: true, signedAt: true },
      });
      return { ...this.base(c), signers };
    });
  }

  async me(scope: Scope, email: string) {
    const customer = await withScope(scope, (tx) => tx.customer.findFirst({ select: { name: true } }));
    return { email, customerName: customer?.name ?? null };
  }
}
```

```typescript
// apps/api/src/portal/portal-contracts.controller.ts
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { PortalService } from './portal.service.js';

@Controller('v1/portal')
export class PortalContractsController {
  constructor(private readonly portal: PortalService) {}

  @Get('contracts')
  list(@CurrentScope() scope: Scope) {
    return this.portal.list(scope);
  }

  @Get('contracts/:id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.findOne(scope, id);
  }

  @Get('me')
  async me(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    // L'email vient de la session ; à défaut, on le lit depuis l'utilisateur.
    const email = (session as any).email ?? await this.portal.emailOf(scope, session.userId);
    return this.portal.me(scope, email);
  }
}
```
Note : si la `Session` ne porte pas l'email, ajouter dans `PortalService` une méthode `emailOf(scope, userId)` qui lit `tx.user.findUnique({ where:{id:userId}, select:{email:true} })` sous `withScope`. (L'implémenteur choisit ; l'email affiché doit être réel.)

Enregistrer `PortalContractsController` (controllers) + `PortalService` (providers) dans `app.module.ts`.

- [ ] **Step 4 : verify redirige**

Dans `portal-auth.controller.ts`, `verify` : en cas de succès, après `setSessionCookie(res, …)`, faire `res.redirect(302, \`${process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr'}/portal/contracts\`)` au lieu de renvoyer le JSON. En cas d'échec, `res.redirect(302, '…/portal/login?error=lien')` (ou conserver 410 — au choix, mais l'échec doit être visible côté front).

- [ ] **Step 5 : lancer, vérifier le succès + suite** — `cd apps/api && pnpm exec vitest run tests/isolation/portal-contracts.test.ts && pnpm exec vitest run` ; typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/portal apps/api/src/app.module.ts apps/api/src/auth/portal-auth.controller.ts apps/api/tests/isolation/portal-contracts.test.ts
git commit -m "feat(portail): API contrats client-safe (liste/fiche/me) + verify redirige vers le portail"
```

---

## Task 2 : garde deny-by-default (session CLIENT confinée au portail)

**Files:** `client-portal.guard.ts`, `app.module.ts`, `client-portal-guard.test.ts`.

**Interfaces:**
- Produces: une session `actorKind='CLIENT'` reçoit **403** sur toute route hors `/v1/portal/*`.

- [ ] **Step 1 : test qui échoue**

```typescript
// apps/api/tests/isolation/client-portal-guard.test.ts
// (réutiliser le montage de portal-contracts.test.ts : app + session 'sess-client' CLIENT sur customerA)
// Assertions clés :
//  - GET /v1/contracts (interne) avec sess-client → 403
//  - GET /v1/portal/contracts avec sess-client → 200
//  - GET /v1/contracts avec une session INTERNE (ACCOUNT_MANAGER) → 200 (non impacté)
```
Écrire ce fichier sur le modèle de `portal-contracts.test.ts` (même `beforeAll` : session CLIENT + une session interne `sess-am` ACCOUNT_MANAGER scoping customerA), avec ces trois assertions.

- [ ] **Step 2 : lancer, vérifier l'échec** (aujourd'hui `/v1/contracts` avec une session CLIENT renvoie 200).

- [ ] **Step 3 : implémenter la garde**

```typescript
// apps/api/src/portal/client-portal.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { ScopedRequest } from '../auth/scope.guard.js';

/**
 * Deny-by-default pour les sessions CLIENT (§6.15, H11).
 *
 * Une session `actorKind='CLIENT'` ne peut atteindre QUE `/v1/portal/*`. Toute
 * autre route est refusée (403) — la surface interne n'est jamais exposée au
 * portail, même en lecture. S'exécute APRÈS le ScopeGuard (qui pose req.session).
 */
@Injectable()
export class ClientPortalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ScopedRequest>();
    const session = req.session;
    if (!session) return true; // route @Public / sans session : ScopeGuard a déjà tranché
    if (session.scope.actorKind === 'CLIENT') {
      const path = req.path ?? req.url ?? '';
      if (!path.startsWith('/v1/portal/')) {
        throw new ForbiddenException('Accès réservé à l’espace client.');
      }
    }
    return true;
  }
}
```

Dans `app.module.ts`, enregistrer comme `APP_GUARD` **après** le `ScopeGuard` (l'ordre des providers `APP_GUARD` = l'ordre d'exécution ; `ScopeGuard` doit poser `req.session` d'abord) :
```typescript
    { provide: APP_GUARD, useClass: ScopeGuard },     // existant
    { provide: APP_GUARD, useClass: ClientPortalGuard }, // AJOUT, après
```

- [ ] **Step 4 : lancer, vérifier le succès + suite complète** — `cd apps/api && pnpm exec vitest run` (la garde est globale : vérifier que les suites internes existantes restent vertes, elles utilisent des sessions INTERNE). typecheck clean.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/portal/client-portal.guard.ts apps/api/src/app.module.ts apps/api/tests/isolation/client-portal-guard.test.ts
git commit -m "feat(portail): garde deny-by-default — une session CLIENT est confinée à /v1/portal/*"
```

---

## Task 3 : Frontend portail (`/portal/*`)

**Files:** `apps/web/src/portal/*`, `apps/web/src/app.tsx`, test.

**Interfaces:**
- Consumes: `GET /v1/portal/contracts`, `/:id`, `/me`, `POST /v1/portal/auth/request-link`.
- Produces: zone `/portal/*` (login, liste, fiche) avec layout + auth propres.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/portal-contracts-page.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalContractsPage } from '../portal/portal-contracts-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('la liste affiche les contrats du portail', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'c1', reference: 'LSI-2026-0001', title: 'Maintenance', status: 'ACTIVE', endDate: '2026-12-31' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractsPage />);
  await waitFor(() => expect(screen.getByText('LSI-2026-0001')).toBeInTheDocument());
  expect(screen.getByText(/Maintenance/)).toBeInTheDocument();
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : `portal-api.ts` (auth portail)**

```typescript
// apps/web/src/portal/portal-api.ts
export class PortalUnauthorized extends Error {}

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new PortalUnauthorized();
  if (!res.ok) throw new Error(`Portail ${res.status}`);
  return res.json() as Promise<T>;
}

export async function portalPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Portail ${res.status}`);
  return res.json() as Promise<T>;
}
```

- [ ] **Step 4 : layout + pages + login**

`portal-layout.tsx` : en-tête « Espace client — LSI Maintenance », email connecté (via `GET /v1/portal/me`), bouton Déconnexion (`POST /v1/portal/auth/logout` puis redirection `/portal/login`), `<Outlet/>`. Aucune nav interne.

`portal-login-page.tsx` : champ email → `portalPost('/v1/portal/auth/request-link', { email })` → message neutre « Si un compte existe, un lien de connexion vient d'être envoyé à cette adresse. ». (Pas de révélation d'existence.)

`portal-contracts-page.tsx` : `useQuery(['portal-contracts'], () => portalGet('/v1/portal/contracts'))` → tableau (réf, titre, statut FR via `labels.ts`, date de fin) ; chaque ligne lie `/portal/contracts/:id`.

`portal-contract-page.tsx` : `useQuery(['portal-contract', id], () => portalGet('/v1/portal/contracts/:id'))` → entête (réf, titre, statut, dates, montant) + bloc **Signataires** (nom, partie FR, statut FR, date). Lecture seule.

`portal-app.tsx` : gère l'auth portail (si `PortalUnauthorized` → redirige `/portal/login`) et le routage interne du portail :
```tsx
export function PortalApp() {
  return (
    <Routes>
      <Route path="login" element={<PortalLoginPage />} />
      <Route element={<PortalLayout />}>
        <Route path="contracts" element={<PortalContractsPage />} />
        <Route path="contracts/:id" element={<PortalContractPage />} />
        <Route index element={<Navigate to="contracts" replace />} />
      </Route>
    </Routes>
  );
}
```
Gestion 401 : un petit wrapper (ou un `onError` de query) qui, sur `PortalUnauthorized`, `navigate('/portal/login')`. (L'implémenteur peut utiliser un ErrorBoundary de query ou tester `isError` dans chaque page ; garder simple.)

- [ ] **Step 5 : brancher `/portal/*` dans `app.tsx`**

Restructurer pour séparer les zones :
```tsx
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/portal/*" element={<PortalApp />} />
        <Route path="/*" element={<RequireAuth><InternalRoutes /></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
```
où `InternalRoutes` regroupe les `<Route>` internes existantes sous `<AppShell/>` (déplacer le contenu actuel du `<RequireAuth>` dans un composant `InternalRoutes`). La zone portail n'est **pas** enveloppée par le `RequireAuth` interne (qui redirige vers l'OIDC).

- [ ] **Step 6 : lancer** — `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 7 : Commit** — `git add apps/web/src && git commit -m "feat(web): portail client — zone /portal/* (login, liste, fiche lecture seule)"`

---

## Clôture

- [ ] Suites : `apps/api`, `@lsi/web` — vertes. CI locale verte.
- [ ] Merge `main` → CI → redéploiement (env live préservé). **Aucune migration.**
- [ ] Validation prod prudente : demander un magic link sur une **adresse de test** cliente, se connecter, vérifier la liste + fiche + le confinement (une session cliente ne voit pas l'interne).
