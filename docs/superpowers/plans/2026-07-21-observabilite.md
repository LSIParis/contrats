# Observabilité applicative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre la prod diagnosticable sans nouvelle infra : logs JSON (pino) + request-id corrélé au journal d'audit, endpoint de readiness profond (Postgres+Redis), filtre d'exception global.

**Architecture:** `nestjs-pino` en logger global + `genReqId` (request-id → réponse + `req.id` + `audit_logs.request_id`) ; `GET /health/ready` pinguant Postgres (helper persistence) et Redis (ioredis) ; `AllExceptionsFilter` global qui préserve le corps d'erreur existant en y ajoutant `requestId` et logue les 5xx.

**Tech Stack:** NestJS (Express, SWC), nestjs-pino/pino, ioredis, Prisma ; Vitest + supertest.

## Global Constraints

- Logs `silent` en test (`NODE_ENV==='test'`, posé par Vitest) — les tests ne doivent pas être noyés ni ralentis par le logging.
- Le health controller (dans `apps/api`) **ne peut pas** importer `unsafeUnscopedClient` (règle lint §10.3) → ping DB via un helper **du package persistence**.
- Le filtre d'exception **préserve** le corps d'erreur existant (`HttpException.getResponse()`) et y **ajoute** `requestId` — il ne réécrit pas les corps, pour ne pas casser les tests existants ; une erreur inconnue → 500 `{ statusCode, message:'Erreur interne', requestId }` (jamais de stack exposée).
- Ajout de dépendances → **mettre à jour `pnpm-lock.yaml`** (la CI utilise `--frozen-lockfile`). Lancer `pnpm lint && pnpm typecheck` avant de terminer chaque tâche.
- IDs via `uuidv7` (de `@lsi/persistence`). Imports ESM `.js`.

---

### Task 1: Logs structurés (pino) + request-id + corrélation audit

**Files:**
- Modify: `apps/api/package.json` (deps) + `pnpm-lock.yaml`
- Modify: `apps/api/src/app.module.ts` (LoggerModule.forRoot)
- Modify: `apps/api/src/main.ts` (bufferLogs + useLogger)
- Modify: `apps/api/src/audit/audit.interceptor.ts` (`requestId` = `req.id`)
- Test: `apps/api/tests/isolation/request-id.test.ts`

**Interfaces:**
- Produces : chaque réponse HTTP porte `x-request-id` ; `req.id` disponible ; `audit_logs.request_id` renseigné.

- [ ] **Step 1: Ajouter les dépendances**

Run: `pnpm --filter @lsi/api add nestjs-pino pino pino-http`
Expected: `apps/api/package.json` + `pnpm-lock.yaml` mis à jour.

- [ ] **Step 2: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/request-id.test.ts` :

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

async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-RQ-${id.slice(-8)}`,
    title: 'ReqId', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});

describe('request-id', () => {
  test('une réponse porte un en-tête x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{16,}/);
  });

  test('un x-request-id entrant est conservé', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('x-request-id', 'trace-abc-123').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  test('une mutation auditée renseigne audit_logs.request_id', async () => {
    const c = await seedContract();
    await request(app.getHttpServer()).post(`/v1/contracts/${c}/comments`)
      .set('x-lsi-session', 'sess-am').set('x-request-id', 'trace-audit-xyz')
      .send({ body: 'tracé', visibility: 'INTERNAL' }).expect(201);
    // best-effort fire-and-forget : on attend l'entrée
    let reqId: string | null = null;
    for (let i = 0; i < 40 && !reqId; i++) {
      const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$queryRaw<{ request_id: string | null }[]>`
          SELECT request_id FROM audit_logs WHERE tenant_id=${fx.tenantId}::uuid AND action LIKE '%comments%' ORDER BY seq DESC LIMIT 1`);
      reqId = rows[0]?.request_id ?? null;
      if (!reqId) await new Promise((r) => setTimeout(r, 50));
    }
    expect(reqId).toBe('trace-audit-xyz');
  });
});
```

- [ ] **Step 3: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- request-id`
Expected: FAIL (pas d'en-tête x-request-id ; request_id NULL).

- [ ] **Step 4: Configurer nestjs-pino dans AppModule**

Dans `apps/api/src/app.module.ts`, ajouter l'import et le module :

```ts
import { LoggerModule } from 'nestjs-pino';
import { uuidv7 } from '@lsi/persistence';
```

Dans le tableau `imports` du `@Module`, ajouter en tête :

```ts
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
        autoLogging: process.env.NODE_ENV !== 'test',
        redact: ['req.headers.cookie', 'req.headers.authorization'],
        genReqId: (req: any, res: any) => {
          const incoming = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
          const id = incoming ?? uuidv7();
          res.setHeader('x-request-id', id);
          return id;
        },
      },
    }),
```

- [ ] **Step 5: Brancher le logger dans main.ts**

Dans `apps/api/src/main.ts` :

```ts
import { Logger } from 'nestjs-pino';
```

Remplacer la création de l'app :

```ts
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger));
```

- [ ] **Step 6: Corréler l'audit au request-id**

Dans `apps/api/src/audit/audit.interceptor.ts`, remplacer la ligne `requestId` :

```ts
          requestId: (req.id as string) ?? (req.headers?.['x-request-id'] as string) ?? null,
```

- [ ] **Step 7: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- request-id`
Expected: PASS (3/3).

- [ ] **Step 8: Non-régression large + lint + typecheck**

Run: `pnpm --filter @lsi/api test` puis `pnpm lint` puis `pnpm typecheck`
Expected: PASS partout (le logger silencieux en test ne casse rien).

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/app.module.ts apps/api/src/main.ts apps/api/src/audit/audit.interceptor.ts apps/api/tests/isolation/request-id.test.ts
git commit -m "feat(obs): logs structurés pino + request-id (en-tête + req.id) corrélé au journal d'audit"
```

---

### Task 2: Readiness profond `/health/ready` (Postgres + Redis)

**Files:**
- Create: `apps/api/src/health/health.controller.ts`
- Modify: `apps/api/src/app.module.ts` (retirer le HealthController inline, importer le nouveau)
- Create: `packages/persistence/src/health.ts` (`pingDatabase`) + export dans `index.ts`
- Test: `apps/api/tests/isolation/health-ready.test.ts`

**Interfaces:**
- Consumes: `REDIS` (ioredis) de `../auth/redis.provider.js` ; `pingDatabase` de `@lsi/persistence`.
- Produces: `GET /health` (liveness), `GET /health/ready` (readiness 200/503).

- [ ] **Step 1: Helper persistence `pingDatabase`**

Créer `packages/persistence/src/health.ts` :

```ts
import { unsafeUnscopedClient } from './scoped-client.js';

/** Vérifie que la base répond (readiness). N'échoue jamais : renvoie false. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await unsafeUnscopedClient.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
```

Ajouter dans `packages/persistence/src/index.ts` :

```ts
export { pingDatabase } from './health.js';
```

- [ ] **Step 2: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/health-ready.test.ts` :

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { REDIS } from '../../src/auth/redis.provider.js';

describe('readiness', () => {
  test('/health reste un liveness léger', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    await app.close();
  });

  test('/health/ready → 200 avec checks quand tout répond', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { db: true, redis: true } });
    await app.close();
  });

  test('/health/ready → 503 si Redis ne répond pas', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS)
      .useValue({ ping: async () => { throw new Error('redis down'); } })
      .compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { redis: false } });
    await app.close();
  });
});
```

- [ ] **Step 3: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- health-ready`
Expected: FAIL (route `/health/ready` absente).

- [ ] **Step 4: Créer le HealthController dédié**

Créer `apps/api/src/health/health.controller.ts` :

```ts
import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { pingDatabase } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { REDIS } from '../auth/redis.provider.js';

@Controller()
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('health/ready')
  async ready() {
    const [db, redis] = await Promise.all([
      pingDatabase(),
      this.redis.ping().then(() => true).catch(() => false),
    ]);
    const ok = db && redis;
    const body = { status: ok ? 'ok' : 'degraded', checks: { db, redis } };
    if (!ok) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
```

- [ ] **Step 5: Câbler dans app.module.ts**

Retirer la classe `HealthController` déclarée inline dans `app.module.ts` (le bloc `@Controller() class HealthController { … }`), ajouter l'import :

```ts
import { HealthController } from './health/health.controller.js';
```

`HealthController` reste dans le tableau `controllers` (référence désormais l'import). Retirer `@Public`/`@Get`/`@Controller` inutilisés de l'import `@nestjs/common` d'app.module.ts **seulement s'ils ne servent plus ailleurs** (vérifier).

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- health-ready`
Expected: PASS (3/3).

- [ ] **Step 7: Non-régression + lint + typecheck**

Run: `pnpm --filter @lsi/api test -- health request-id` puis `pnpm lint` puis `pnpm typecheck`
Expected: PASS partout.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/health apps/api/src/app.module.ts packages/persistence/src/health.ts packages/persistence/src/index.ts apps/api/tests/isolation/health-ready.test.ts
git commit -m "feat(obs): readiness /health/ready (ping Postgres + Redis, 503 si dégradé)"
```

---

### Task 3: Filtre d'exception global

**Files:**
- Create: `apps/api/src/common/all-exceptions.filter.ts`
- Modify: `apps/api/src/app.module.ts` (APP_FILTER)
- Test: `apps/api/tests/isolation/exception-filter.test.ts`

**Interfaces:**
- Produces: tout corps d'erreur porte `requestId` ; les 5xx sont loguées.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/exception-filter.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});

describe('filtre d’exception global', () => {
  test('une 404 (HttpException) renvoie un corps avec requestId, statut préservé', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts/00000000-0000-7000-8000-000000000000')
      .set('x-lsi-session', 'sess-am')
      .expect(404);
    expect(res.body.requestId).toMatch(/[0-9a-f-]{16,}/);
    expect(res.body.statusCode ?? 404).toBe(404); // corps HttpException préservé
  });
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- exception-filter`
Expected: FAIL (`requestId` absent du corps 404).

- [ ] **Step 3: Créer le filtre**

Créer `apps/api/src/common/all-exceptions.filter.ts` :

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res: any = ctx.getResponse();
    const req: any = ctx.getRequest();
    const requestId = (req.id as string) ?? (req.headers?.['x-request-id'] as string) ?? null;

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    // Préserver le corps existant (HttpException) ; y ajouter requestId.
    const raw = isHttp ? exception.getResponse() : { statusCode: status, message: 'Erreur interne' };
    const body = typeof raw === 'string' ? { statusCode: status, message: raw } : { ...(raw as object) };
    (body as any).requestId = requestId;

    // On ne logue QUE les 5xx (les 4xx sont attendues + déjà tracées par pino-http).
    if (status >= 500) {
      this.logger.error({ err: exception, requestId, method: req.method, path: req.url, status }, 'Erreur non gérée');
    }
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Enregistrer en APP_FILTER**

Dans `apps/api/src/app.module.ts` : importer

```ts
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { APP_FILTER } from '@nestjs/core';
```

Ajouter aux `providers` :

```ts
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
```

- [ ] **Step 5: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- exception-filter`
Expected: PASS.

- [ ] **Step 6: Non-régression LARGE (le filtre touche TOUTES les erreurs) + lint + typecheck**

Run: `pnpm --filter @lsi/api test` puis `pnpm lint` puis `pnpm typecheck`
Expected: PASS. **Si une suite casse** parce qu'elle asserte un corps d'erreur exact : le filtre ne doit qu'AJOUTER `requestId` (jamais retirer/renommer un champ). Diagnostique : le corps préservé doit contenir les mêmes champs qu'avant (statusCode/message/code/detail selon l'exception). Ne commite pas une régression.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/common/all-exceptions.filter.ts apps/api/src/app.module.ts apps/api/tests/isolation/exception-filter.test.ts
git commit -m "feat(obs): filtre d'exception global — requestId dans le corps + log des 5xx"
```

---

## Self-Review

**Spec coverage :**
- §3.1 pino + request-id + corrélation audit → Task 1 ✅
- §3.2 readiness DB+Redis + pingDatabase → Task 2 ✅
- §3.3 filtre d'exception global → Task 3 ✅
- §5 tests (request-id header/echo/audit, readiness 200/503, filtre requestId) → Task 1/2/3 ✅

**Placeholders :** aucun. Config pino, controller, filtre : code complet.

**Cohérence des types :** `genReqId` pose `req.id` (Task 1) ← lu par l'intercepteur d'audit (Task 1) ET le filtre (Task 3). `pingDatabase` (persistence, Task 2) ← health controller (Task 2). `REDIS` injecté (Task 2). Le filtre préserve le corps `HttpException` (compat tests existants), ajoute `requestId`.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
