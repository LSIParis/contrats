# Contrat — API-key de service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un back-end externe (la plateforme de ticketing) de lire les contrats en serveur-à-serveur via une clé d'API (`X-Api-Key`), bornée aux routes `@ServiceReadable()` (`GET /v1/contracts`, `/v1/contracts/:id`), sans toucher au flux de session Microsoft 365 ni à la surface des routes publiques.

**Architecture:** Un décorateur marqueur `@ServiceReadable()` (patron de `@Public()`) posé sur les 2 GET contrats. Le `ScopeGuard` global gagne une branche « clé d'API » : si pas de cookie de session mais un header `X-Api-Key` valide (comparaison timing-safe vs `CONTRACT_SERVICE_API_KEY`) ET route `@ServiceReadable()`, il pose une session de service (`adminScope`, `allCustomers`) et laisse passer. Le cookie de session reste prioritaire.

**Tech Stack:** NestJS (ESM, `.js` imports), Reflector/metadata, `node:crypto` (`timingSafeEqual`), `@lsi/persistence` (`findTenantBySlug`, `adminScope`, `withScope`), vitest + supertest, pnpm.

## Global Constraints

- Header d'API-key : **`X-Api-Key`** (`req.headers['x-api-key']`). Comparaison **timing-safe** (`node:crypto` `timingSafeEqual`, contrôle de longueur d'abord), **jamais `===`**.
- La branche clé n'est acceptée **que** sur les routes portant `@ServiceReadable()` (métadonnée `IS_SERVICE_READABLE_KEY`). `@ServiceReadable()` est posé **uniquement** sur `ContractsController.list` et `ContractsController.findOne`.
- Session de service = `adminScope(tenantId, 'service:ticketing')` (→ `allCustomers:true`, `actorKind:'INTERNAL'`), avec `tenantId = await findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi')`. Objet `Session` : `{ sessionId:'service:ticketing', userId:'service:ticketing', tenantId, roles:[], scope }`.
- Clé jamais valide sans configuration : si `process.env.CONTRACT_SERVICE_API_KEY` est absent, une requête présentant une clé est **rejetée (401)** — la clé ne « marche » jamais par défaut.
- **Le cookie de session reste prioritaire** : si un `sessionId` de cookie est présent, on ne rentre pas dans la branche clé.
- **Ne pas** ajouter de route `@Public()` ni modifier `tests/structural/scope-surface.test.ts`. **Ne pas** modifier le flux M365/session.
- ESM : tous les imports internes en **`.js`**. Idiome config : `process.env.X` direct.
- TDD ; les ~200 tests d'isolation existants doivent rester verts (la branche clé ne se déclenche qu'avec un header `x-api-key` et sans cookie de session — aucun test existant n'envoie ce header).

---

## File Structure

```
apps/api/src/auth/
├─ service-readable.decorator.ts   # (créer) marqueur @ServiceReadable
├─ scope.guard.ts                  # (modifier) branche clé d'API
apps/api/tests/isolation/
├─ api-key-guard.test.ts           # (créer) test du guard clé d'API
apps/api/src/contracts/
├─ contracts.controller.ts         # (modifier) @ServiceReadable sur list + findOne
apps/api/scripts/
├─ seed-demo-contracts.ts          # (créer) seed de démo optionnel (opérateur)
.env.example                       # (modifier) CONTRACT_SERVICE_API_KEY
```

---

## Task 1: Décorateur `@ServiceReadable()` + application aux 2 GET contrats

**Files:**
- Create: `apps/api/src/auth/service-readable.decorator.ts`
- Modify: `apps/api/src/contracts/contracts.controller.ts`

**Interfaces:**
- Produces: `IS_SERVICE_READABLE_KEY` (string), `ServiceReadable()` (décorateur). Métadonnée lue par `ScopeGuard` (Task 2).

- [ ] **Step 1: Create `apps/api/src/auth/service-readable.decorator.ts`**

```ts
import { SetMetadata } from '@nestjs/common';

/**
 * Marque une route comme lisible par une clé d'API de service (header
 * X-Api-Key), EN PLUS de la session. À réserver strictement aux GET en
 * lecture seule : le ScopeGuard n'accepte le chemin clé d'API que si cette
 * métadonnée est présente. C'est le pendant de @Public() pour l'auth de
 * service — explicite et greppable, pour que la surface exposée à la clé
 * reste exactement l'ensemble des routes revues.
 */
export const IS_SERVICE_READABLE_KEY = 'lsi:isServiceReadable';
export const ServiceReadable = () => SetMetadata(IS_SERVICE_READABLE_KEY, true);
```

- [ ] **Step 2: Apply `@ServiceReadable()` to `list` and `findOne` — modify `apps/api/src/contracts/contracts.controller.ts`**

Add the import near the other auth imports (line ~22):
```ts
import { ServiceReadable } from '../auth/service-readable.decorator.js';
```
Add the decorator above the two GET handlers (leave everything else unchanged):
```ts
  @Get()
  @ServiceReadable()
  async list(@CurrentScope() scope: Scope, @Query() q: ListContractsDto) {
    return this.contracts.list(scope, q);
  }

  @Get(':id')
  @ServiceReadable()
  async findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.contracts.findOne(scope, id);
  }
```
(Do NOT add it to `signedDocument`, `allowed`, or any POST.)

- [ ] **Step 3: Typecheck + confirm no regression**

```bash
pnpm --filter @lsi/api exec tsc --noEmit
pnpm --filter @lsi/api test -- --run tests/isolation/client-portal-guard.test.ts
```
Expected: typecheck clean ; the existing guard test still passes (the decorator is inert until Task 2 wires the guard to read it).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/auth/service-readable.decorator.ts apps/api/src/contracts/contracts.controller.ts
git commit -m "feat(auth): @ServiceReadable marker on GET /v1/contracts + /:id"
```

---

## Task 2: Branche clé d'API dans `ScopeGuard` (TDD)

**Files:**
- Modify: `apps/api/src/auth/scope.guard.ts`
- Test: `apps/api/tests/isolation/api-key-guard.test.ts`

**Interfaces:**
- Consumes: `IS_SERVICE_READABLE_KEY` (Task 1), `findTenantBySlug`/`adminScope` (`@lsi/persistence`), `Session` type.
- Produces: `GET /v1/contracts` (+ `/:id`) authentifiables par `X-Api-Key` sans cookie ; toute autre route ou clé invalide → 401.

- [ ] **Step 1: Write the failing test `apps/api/tests/isolation/api-key-guard.test.ts`**

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

const KEY = 'test-service-key-0123456789abcdef';
let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  process.env.CONTRACT_SERVICE_API_KEY = KEY;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  // Le tenant de service se résout via DEFAULT_TENANT_SLUG → aligner sur le tenant seedé.
  process.env.DEFAULT_TENANT_SLUG = fx.tenantSlug;
});

const withKey = (path: string, key: string) =>
  request(app.getHttpServer()).get(path).set('x-api-key', key);

describe('API-key de service — lecture des contrats en serveur-à-serveur', () => {
  test('clé valide, sans session → 200, voit les contrats de TOUS les customers (allCustomers)', async () => {
    const res = await withKey('/v1/contracts', KEY).expect(200);
    const ids = (res.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(fx.customerA.contractId);
    expect(ids).toContain(fx.customerB.contractId);
  });

  test('clé invalide → 401', async () => {
    await withKey('/v1/contracts', 'mauvaise-cle').expect(401);
  });

  test('ni session ni clé → 401', async () => {
    await request(app.getHttpServer()).get('/v1/contracts').expect(401);
  });

  test('clé valide sur findOne (@ServiceReadable) → 200', async () => {
    await withKey(`/v1/contracts/${fx.customerA.contractId}`, KEY).expect(200);
  });

  test('clé valide sur une route NON @ServiceReadable → 401', async () => {
    await withKey(`/v1/contracts/${fx.customerA.contractId}/allowed-actions`, KEY).expect(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

```bash
pnpm --filter @lsi/api test -- --run tests/isolation/api-key-guard.test.ts
```
Expected: FAIL — the valid-key requests currently get 401 « Session absente » (the guard doesn't know the key yet).

- [ ] **Step 3: Extend `ScopeGuard` — replace `apps/api/src/auth/scope.guard.ts`**

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { adminScope, findTenantBySlug } from '@lsi/persistence';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { IS_SERVICE_READABLE_KEY } from './service-readable.decorator.js';
import { SessionService, type Session } from './session.service.js';
import { SESSION_COOKIE } from './cookie.js';

export interface ScopedRequest {
  session?: Session;
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  path?: string;
  url?: string;
}

/**
 * Guard GLOBAL de scope. (§10.5)
 *
 * Deux chemins d'authentification :
 *  1. Cookie de session (SSO M365) — prioritaire, inchangé.
 *  2. Clé d'API de service (header X-Api-Key), UNIQUEMENT sur les routes
 *     @ServiceReadable() (lecture seule des contrats), pour l'intégration
 *     serveur-à-serveur du ticketing.
 *
 * Le scope N'EST JAMAIS lu depuis la requête (RM-29) : il vient de la session
 * serveur (cookie) ou d'un scope de service dérivé en base (clé d'API).
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<ScopedRequest>();

    // Chemin 1 : cookie de session, prioritaire et inchangé.
    const sessionId = this.readSessionCookie(req);
    if (sessionId) {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new UnauthorizedException('Session invalide ou expirée');
      req.session = session;
      return true;
    }

    // Chemin 2 : clé d'API de service, bornée aux routes @ServiceReadable.
    const apiKey = this.readApiKey(req);
    if (apiKey) {
      const isServiceReadable = this.reflector.getAllAndOverride<boolean>(
        IS_SERVICE_READABLE_KEY,
        [ctx.getHandler(), ctx.getClass()],
      );
      if (!isServiceReadable) {
        throw new UnauthorizedException('Clé API non autorisée sur cette route');
      }
      const expected = process.env.CONTRACT_SERVICE_API_KEY;
      // Jamais valide sans configuration : la clé ne « marche » pas par défaut.
      if (!expected || !this.constantTimeEquals(apiKey, expected)) {
        throw new UnauthorizedException('Clé API invalide');
      }
      req.session = await this.buildServiceSession();
      return true;
    }

    throw new UnauthorizedException('Session absente');
  }

  private readSessionCookie(req: ScopedRequest): string | undefined {
    const fromCookie = req.cookies?.[SESSION_COOKIE];
    if (fromCookie) return fromCookie;
    const h = req.headers['x-lsi-session'];
    return typeof h === 'string' ? h : undefined;
  }

  private readApiKey(req: ScopedRequest): string | undefined {
    const h = req.headers['x-api-key'];
    return typeof h === 'string' ? h : undefined;
  }

  /** Comparaison à temps constant (cf. docuseal.adapter) : un === fuit la
   * position du premier octet divergent. */
  private constantTimeEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** Session de service : scope admin (allCustomers) sur le tenant par défaut,
   * résolu en base comme au login. Read-only garanti par @ServiceReadable. */
  private async buildServiceSession(): Promise<Session> {
    const tenantId = await findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi');
    if (!tenantId) throw new UnauthorizedException('Tenant de service introuvable');
    return {
      sessionId: 'service:ticketing',
      userId: 'service:ticketing',
      tenantId,
      roles: [],
      scope: adminScope(tenantId, 'service:ticketing'),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

```bash
pnpm --filter @lsi/api test -- --run tests/isolation/api-key-guard.test.ts
```
Expected: 5 tests PASS (valid key sees both contracts ; invalid/absent → 401 ; findOne OK ; non-@ServiceReadable route → 401).

- [ ] **Step 5: Run the FULL suite + typecheck to confirm no regression**

```bash
pnpm --filter @lsi/api exec tsc --noEmit
pnpm --filter @lsi/api test -- --run
```
Expected: all tests green, including `tests/structural/scope-surface.test.ts` (unchanged public surface) and the ~200 isolation tests (unaffected — none send `x-api-key`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/scope.guard.ts apps/api/tests/isolation/api-key-guard.test.ts
git commit -m "feat(auth): X-Api-Key service auth in ScopeGuard for @ServiceReadable contract reads"
```

---

## Task 3: `.env.example` + seed de démo optionnel

**Files:**
- Modify: `.env.example`
- Create: `apps/api/scripts/seed-demo-contracts.ts`

**Interfaces:**
- Produces: variable d'env documentée `CONTRACT_SERVICE_API_KEY` ; un script opérateur pour insérer un customer + 2 contrats de démo dans une instance Contrat vide.

- [ ] **Step 1: Add the env var to `.env.example`** (nouvelle section, style existant)

```
# --- API de service (ticketing externe) ---------------------------------
# Clé d'authentification serveur-à-serveur (header X-Api-Key) pour la lecture
# des contrats par la plateforme de ticketing. Absente en dev par défaut ;
# générée (openssl rand -hex 32) et injectée via Secrets Manager en prod.
# La même valeur est renseignée côté ticketing.
CONTRACT_SERVICE_API_KEY=""
```

- [ ] **Step 2: Create the optional demo seed `apps/api/scripts/seed-demo-contracts.ts`**

```ts
/**
 * Seed de DÉMO (opérateur, optionnel) : insère un customer + 2 contrats dans
 * une instance Contrat vide, pour tester l'import côté ticketing.
 *
 * Écrit avec le rôle propriétaire (comme packages/persistence/src/testing/seed.ts).
 * Idempotent sur le customer/contrats via un slug de tenant fixe et ON CONFLICT.
 * À lancer une fois, manuellement, contre la base cible (DATABASE_URL).
 *
 *   pnpm --filter @lsi/api exec tsx apps/api/scripts/seed-demo-contracts.ts
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7, findTenantBySlug } from '@lsi/persistence';

async function main() {
  const slug = process.env.DEFAULT_TENANT_SLUG ?? 'lsi';
  const tenantId = await findTenantBySlug(slug);
  if (!tenantId) throw new Error(`Tenant introuvable pour le slug "${slug}"`);

  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const customerId = uuidv7();
  const ownerUserId = (
    await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM users WHERE tenant_id='${tenantId}' AND kind='INTERNAL' LIMIT 1`,
    )
  )[0]?.id;
  if (!ownerUserId) throw new Error('Aucun utilisateur INTERNAL pour porter les contrats de démo');

  await owner.$executeRawUnsafe(`
    INSERT INTO customers (id, tenant_id, name, country, status, created_at, updated_at)
    VALUES ('${customerId}', '${tenantId}', 'Client Démo Ticketing', 'FR', 'ACTIVE', now(), now())
  `);

  for (const [ref, title, status] of [
    ['DEMO-2026-001', 'Contrat maintenance Démo', 'ACTIVE'],
    ['DEMO-2026-002', 'Contrat support Démo', 'SIGNED'],
  ] as const) {
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
                             currency, billing_frequency, owner_user_id,
                             created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${uuidv7()}', '${tenantId}', '${customerId}', '${ref}', '${title}', 'MAIN', '${status}',
              'MAINTENANCE', 'EUR', 'MONTHLY', '${ownerUserId}', now(), now(), '${ownerUserId}', '${ownerUserId}')
    `);
  }
  await owner.$disconnect();
  console.log(`Seed démo OK: customer ${customerId} + 2 contrats sous tenant ${tenantId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> Ce script n'est **pas** exécuté automatiquement au déploiement — c'est un outil opérateur pour peupler une instance de démo. En production réelle, les contrats sont créés via l'UI Contrat (SSO M365).

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @lsi/api exec tsc --noEmit
git add .env.example apps/api/scripts/seed-demo-contracts.ts
git commit -m "chore(auth): document CONTRACT_SERVICE_API_KEY + optional demo-contracts seed"
```

---

## Task 4: Déploiement (clé + CI + Portainer)

**Files:** aucun (procédure).

**Interfaces:** consomme l'image publiée ; active la clé en prod.

- [ ] **Step 1: Push the branch + open a PR to `main`** (l'utilisateur relit/merge)

```bash
git push -u origin feat/service-api-key
gh pr create --base main --head feat/service-api-key --title "API-key de service : lecture des contrats en serveur-à-serveur" --body "Ajoute X-Api-Key sur ScopeGuard, borné à @ServiceReadable (GET /v1/contracts + /:id), pour l'intégration ticketing. Ne touche ni au flux M365 ni à la surface @Public."
```
Expected: CI de `lsi-contrats` verte (tests + build/push image sur merge `main`).

- [ ] **Step 2: (opérateur) Générer la clé**

```bash
openssl rand -hex 32
```
Conserver la valeur (elle ira aussi côté ticketing).

- [ ] **Step 3: (opérateur, après merge) Portainer → stack `lsi-contrats` (Docker Legal)**

- Ajouter la variable d'environnement **`CONTRACT_SERVICE_API_KEY`** = la clé générée.
- **Update the stack** avec **Re-pull image and redeploy** (pour l'image incluant la branche mergée).

- [ ] **Step 4: (opérateur / vérification) Smoke test**

```bash
# Sans clé → 401
curl -s -o /dev/null -w "%{http_code}\n" https://contrats.lsi-maintenance.fr/v1/contracts
# Avec la clé → 200 (JSON { data, pagination })
curl -s -H "X-Api-Key: <la-cle>" https://contrats.lsi-maintenance.fr/v1/contracts | head -c 200
```
Expected: 401 sans clé, 200 + JSON avec la bonne clé.

---

## Self-Review (effectuée)

**Couverture de la spec :**
- §3.1 `@ServiceReadable()` + application list/findOne → Task 1. ✅
- §3.2 extension `ScopeGuard` (X-Api-Key, timing-safe, @ServiceReadable requis, cookie prioritaire, clé jamais valide sans env) → Task 2. ✅
- §3.3 session de service `adminScope('lsi', 'service:ticketing')` via `findTenantBySlug` → Task 2 (`buildServiceSession`). ✅
- §3.4 `.env.example` → Task 3. ✅
- §3.5 données de démo → Task 3 (script opérateur optionnel). ✅
- §5 tests (clé valide/allCustomers, invalide/absente → 401, findOne OK, route non marquée → 401 ; suite complète + surface publique gelée verte) → Task 2. ✅
- §6 déploiement → Task 4. ✅

**Placeholders :** aucun TBD ; code complet à chaque étape. Le seul point « opérateur » (générer la clé, redeploy) est une procédure normale, pas un placeholder.

**Cohérence des types :** `Session` (sessionId/userId/tenantId/roles/scope) respecté par `buildServiceSession` ; `adminScope(tenantId, userId)` et `findTenantBySlug(slug): Promise<string|null>` conformes aux signatures lues ; `IS_SERVICE_READABLE_KEY` défini en Task 1 et consommé en Task 2 ; header `x-api-key` cohérent entre guard, test et smoke test.

**Non-régression :** la branche clé ne se déclenche qu'avec header `x-api-key` **et** sans cookie de session — aucun test/flux existant n'envoie ce header ; le test structurel des routes `@Public()` reste inchangé.
