# Gestion des utilisateurs — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Un écran MSP_ADMIN pour créer/lister/activer-désactiver des utilisateurs (internes OIDC + clients magic link) et gérer leurs rôles, sans SQL.

**Architecture:** Module `users` (API) sous `withScope` MSP_ADMIN (RLS autorise déjà create/modify dans le tenant) ; rôles assignés par find-or-create. Frontend : écran `/users` dans le cockpit interne, lien de nav gardé MSP_ADMIN.

**Tech Stack:** NestJS 10, Prisma 5, React 18, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité** : `assertRole(['MSP_ADMIN'])` sur tous les endpoints (403 sinon) ; scopé au tenant (RLS) ; `kind` immuable (RM-32) ; garde « au moins un MSP_ADMIN actif » (409). Le front ne porte aucune autorisation (masque juste le lien).
- Rôles internes = {MSP_ADMIN, ACCOUNT_MANAGER, LEGAL_REVIEWER, TECHNICIAN} ; rôles client = {CLIENT_SIGNER, CLIENT_VIEWER}. Cohérence kind↔rôles → 422.
- **Aucune migration** (RLS autorise MSP_ADMIN à écrire users/user_roles/roles ; enums préexistants). Rôles non seedés par tenant → find-or-create.
- MSP_ADMIN a `all_customers` → voit tout le tenant. Pattern de test API : `SessionService.put` + `x-lsi-session` ; `seedTwoCustomers` ; `adminScope(tenantId, userId)`.

---

## Structure de fichiers

- Create: `apps/api/src/users/users.service.ts`, `apps/api/src/users/users.controller.ts`, `apps/api/src/users/dto/create-user.dto.ts`, `apps/api/src/users/dto/update-user.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/users.test.ts`
- Create (front): `apps/web/src/features/users/users-page.tsx`
- Modify: `apps/web/src/app.tsx` (route `/users`), `apps/web/src/shell/app-shell.tsx` (lien nav MSP_ADMIN), `apps/web/src/lib/labels.ts` (libellés rôles)
- Test: `apps/web/src/test/users-page.test.tsx`

---

## Task 1 : API gestion des utilisateurs

**Files:** DTOs + `users.service.ts` + `users.controller.ts` + `app.module.ts` + `users.test.ts`.

**Interfaces:**
- Produces: `GET /v1/users`, `POST /v1/users`, `PATCH /v1/users/:id` (MSP_ADMIN).

- [ ] **Step 1 : DTOs**

```typescript
// apps/api/src/users/dto/create-user.dto.ts
import { IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
const ROLE_CODES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN', 'CLIENT_SIGNER', 'CLIENT_VIEWER'] as const;

export class CreateUserDto {
  @IsEnum(['INTERNAL', 'CLIENT']) kind!: 'INTERNAL' | 'CLIENT';
  @IsEmail() email!: string;
  @IsString() @MinLength(1) fullName!: string;
  @IsOptional() @IsUUID('7') customerId?: string;
  @IsArray() @IsEnum(ROLE_CODES, { each: true }) roles!: string[];
}
```
```typescript
// apps/api/src/users/dto/update-user.dto.ts
import { IsArray, IsEnum, IsOptional } from 'class-validator';
const ROLE_CODES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN', 'CLIENT_SIGNER', 'CLIENT_VIEWER'] as const;

export class UpdateUserDto {
  @IsOptional() @IsEnum(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
  @IsOptional() @IsArray() @IsEnum(ROLE_CODES, { each: true }) roles?: string[];
}
```

- [ ] **Step 2 : test qui échoue**

```typescript
// apps/api/tests/isolation/users.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const post = (body: object, sess = 'sess-admin') => request(app.getHttpServer()).post('/v1/users').set('x-lsi-session', sess).send(body);

describe('gestion des utilisateurs (MSP_ADMIN)', () => {
  test('créer un utilisateur INTERNE avec des rôles', async () => {
    const res = await post({ kind: 'INTERNAL', email: 'interne1@lsi.fr', fullName: 'Jean Interne', roles: ['ACCOUNT_MANAGER'] }).expect(201);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id: res.body.id }, include: { roles: { include: { role: true } } } }));
    expect(u).toMatchObject({ kind: 'INTERNAL', email: 'interne1@lsi.fr', status: 'ACTIVE', customerId: null });
    expect(u!.roles.map((r: any) => r.role.code)).toContain('ACCOUNT_MANAGER');
  });

  test('créer un utilisateur CLIENT rattaché à un client', async () => {
    const res = await post({ kind: 'CLIENT', email: 'client1@acme.fr', fullName: 'Nathalie', customerId: fx.customerA.id, roles: ['CLIENT_VIEWER'] }).expect(201);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id: res.body.id } }));
    expect(u).toMatchObject({ kind: 'CLIENT', customerId: fx.customerA.id });
  });

  test('CLIENT sans customerId → 422', async () => {
    await post({ kind: 'CLIENT', email: 'c2@acme.fr', fullName: 'X', roles: ['CLIENT_VIEWER'] }).expect(422);
  });
  test('CLIENT avec un rôle interne → 422', async () => {
    await post({ kind: 'CLIENT', email: 'c3@acme.fr', fullName: 'X', customerId: fx.customerA.id, roles: ['ACCOUNT_MANAGER'] }).expect(422);
  });
  test('INTERNE avec un rôle client → 422', async () => {
    await post({ kind: 'INTERNAL', email: 'i2@lsi.fr', fullName: 'X', roles: ['CLIENT_VIEWER'] }).expect(422);
  });
  test('email déjà pris → 409', async () => {
    await post({ kind: 'INTERNAL', email: 'dup@lsi.fr', fullName: 'A', roles: ['TECHNICIAN'] }).expect(201);
    await post({ kind: 'INTERNAL', email: 'dup@lsi.fr', fullName: 'B', roles: ['TECHNICIAN'] }).expect(409);
  });
  test('non-MSP_ADMIN → 403', async () => {
    await post({ kind: 'INTERNAL', email: 'x@lsi.fr', fullName: 'X', roles: ['TECHNICIAN'] }, 'sess-am').expect(403);
  });

  test('GET /v1/users liste les utilisateurs du tenant', async () => {
    const res = await request(app.getHttpServer()).get('/v1/users').set('x-lsi-session', 'sess-admin').expect(200);
    expect(res.body.items.some((u: any) => u.email === 'interne1@lsi.fr')).toBe(true);
    expect(res.body.items[0]).toHaveProperty('roles');
  });

  test('PATCH désactive et modifie les rôles', async () => {
    const id = (await post({ kind: 'INTERNAL', email: 'patch@lsi.fr', fullName: 'P', roles: ['TECHNICIAN'] }).expect(201)).body.id;
    await request(app.getHttpServer()).patch(`/v1/users/${id}`).set('x-lsi-session', 'sess-admin').send({ status: 'DISABLED', roles: ['LEGAL_REVIEWER'] }).expect(200);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } }));
    expect(u!.status).toBe('DISABLED');
    expect(u!.roles.map((r: any) => r.role.code)).toEqual(['LEGAL_REVIEWER']);
  });

  test('on ne peut pas retirer le dernier MSP_ADMIN actif → 409', async () => {
    // fx.adminUserId est le seul MSP_ADMIN actif : le désactiver doit échouer.
    await request(app.getHttpServer()).patch(`/v1/users/${fx.adminUserId}`).set('x-lsi-session', 'sess-admin').send({ status: 'DISABLED' }).expect(409);
  });
});
```
Note : le test « dernier MSP_ADMIN » suppose que `fx.adminUserId` porte le rôle MSP_ADMIN **en base**. `seedTwoCustomers` crée-t-il ce rôle ? Si non, l'implémenteur doit, dans le `beforeAll`, s'assurer que `fx.adminUserId` a une ligne `user_roles` MSP_ADMIN (via `withScope(adminScope…)`), pour que la garde ait un sens.

- [ ] **Step 3 : lancer, vérifier l'échec.**

- [ ] **Step 4 : service + contrôleur**

Libellés FR (dans le service) :
```typescript
const ROLE_LABEL: Record<string, string> = {
  MSP_ADMIN: 'Administrateur', ACCOUNT_MANAGER: 'Chargé de compte', LEGAL_REVIEWER: 'Relecteur juridique',
  TECHNICIAN: 'Technicien', CLIENT_SIGNER: 'Signataire client', CLIENT_VIEWER: 'Lecteur client',
};
const INTERNAL_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN'];
const CLIENT_ROLES = ['CLIENT_SIGNER', 'CLIENT_VIEWER'];
```

`UsersService` (les grandes lignes — l'implémenteur suit les patterns existants) :
- `list(scope)` : `tx.user.findMany({ include: { roles: { include: { role: true } }, customer: { select: { id: true, name: true } } }, orderBy: { fullName: 'asc' } })` → projeter `{ id, email, fullName, kind, status, roles: r.roles.map(x=>x.role.code), customer }`.
- `assertKindRoles(kind, roles)` : CLIENT ⇒ roles ⊆ CLIENT_ROLES ; INTERNAL ⇒ roles ⊆ INTERNAL_ROLES ; sinon `UnprocessableEntityException` (422). CLIENT ⇒ customerId requis (422 si absent).
- `create(scope, dto)` (transaction) : `assertKindRoles` ; si CLIENT vérifier le customer (`tx.customer.findUnique` → sinon 400) ; `tx.user.create({...})` avec catch **P2002 → 409** ; pour chaque code : `roleId = (find-or-create roles (tenant, code, ROLE_LABEL[code]))` puis `tx.userRole.create({ userId, roleId, tenantId })`. `{ id }`.
- `update(scope, id, dto)` : charger le user (+ roles) → 404 sinon. **Garde dernier admin** : si la modif retire MSP_ADMIN (status→DISABLED d'un MSP_ADMIN, ou `roles` sans MSP_ADMIN sur un MSP_ADMIN), compter les AUTRES MSP_ADMIN actifs ; si 0 → `ConflictException` (409, `LAST_ADMIN`). Puis `status` si fourni ; si `roles` fourni : `assertKindRoles(user.kind, roles)`, `tx.userRole.deleteMany({ where:{userId:id} })` + recréer (find-or-create). `{ ok: true }`.

`find-or-create` d'un rôle : `tx.role.findFirst({ where:{ code } })` sinon `tx.role.create({ data:{ id: uuidv7(), tenantId: scope.tenantId, code, label } })` (catch P2002 → refind, course).

Contrôleur `@Controller('v1/users')` : `@Get()` list, `@Post()` create, `@Patch(':id')` update — chacun `assertRole(session, ['MSP_ADMIN'])`, `@CurrentScope`/`@CurrentSession`, `@Body()` DTO, `ParseUUIDPipe` sur `:id`.

Enregistrer `UsersController` + `UsersService` dans `app.module.ts`.

- [ ] **Step 5 : lancer, vérifier le succès + suite** — `cd apps/api && pnpm exec vitest run tests/isolation/users.test.ts && pnpm exec vitest run` ; typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/users apps/api/src/app.module.ts apps/api/tests/isolation/users.test.ts
git commit -m "feat(users): API gestion des utilisateurs (create/list/patch, MSP_ADMIN, kind+roles, dernier admin)"
```

---

## Task 2 : Frontend — écran Utilisateurs

**Files:** `users-page.tsx`, `app.tsx`, `app-shell.tsx`, `labels.ts`, `users-page.test.tsx`.

**Interfaces:**
- Consumes: `GET/POST /v1/users`, `PATCH /v1/users/:id`. Produces l'écran `/users` + le lien nav MSP_ADMIN.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/users-page.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersPage } from '../features/users/users-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('liste les utilisateurs et permet de créer un interne', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).endsWith('/v1/users') && (init?.method ?? 'GET') === 'GET')
      return new Response(JSON.stringify({ items: [{ id: 'u1', email: 'a@lsi.fr', fullName: 'Alice', kind: 'INTERNAL', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], customer: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'u2' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<UsersPage />);
  await waitFor(() => expect(screen.getByText('a@lsi.fr')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Nouvel utilisateur/ }));
  await userEvent.type(screen.getByLabelText(/Email/), 'nouveau@lsi.fr');
  await userEvent.type(screen.getByLabelText(/Nom/), 'Nouveau');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : libellés** — dans `labels.ts`, ajouter `roleLabel(code)` (Administrateur / Chargé de compte / Relecteur juridique / Technicien / Signataire client / Lecteur client) et `userKindLabel(kind)` (Interne / Client).

- [ ] **Step 4 : `UsersPage`**

Composant : `useQuery(['users'], () => apiGet('/v1/users'))` → tableau (nom, email, `userKindLabel(kind)`, client, rôles via `roleLabel`, statut). Bouton **Nouvel utilisateur** ouvre un formulaire :
- `kind` (Interne/Client) → si Client : sélecteur de client (`apiGet('/v1/customers')`) + cases CLIENT_SIGNER/CLIENT_VIEWER ; si Interne : cases des 4 rôles internes.
- email + nom. **Créer** → `apiPost('/v1/users', {...})` → invalide `['users']`. Erreurs (409/422) inline.
- Par ligne : **Activer/Désactiver** → `apiPut`/`apiPatch('/v1/users/:id', { status })`. *(Ajouter un helper `apiPatch` dans `lib/api.ts` s'il n'existe pas — sur le modèle d'`apiPut`.)* Édition des rôles : un petit panneau (cases) → `PATCH { roles }`. Invalide `['users']`.

- [ ] **Step 5 : route + nav**

Dans `app.tsx` (zone interne), ajouter `<Route path="/users" element={<UsersPage />} />`.
Dans `app-shell.tsx`, ajouter un `<li>` **« Utilisateurs »** (`<Link to="/users">`) **rendu seulement si** `me.data?.roles?.includes('MSP_ADMIN')`.

- [ ] **Step 6 : lancer** — `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 7 : Commit** — `git add apps/web/src && git commit -m "feat(web): écran de gestion des utilisateurs (MSP_ADMIN)"`

---

## Clôture

- [ ] Suites : `apps/api`, `@lsi/web` — vertes. CI locale verte.
- [ ] Merge `main` → CI → redéploiement. **Aucune migration.**
- [ ] Validation prod : créer un **contact client de test** pour LSSI via l'écran → il demande un magic link → teste le portail.
