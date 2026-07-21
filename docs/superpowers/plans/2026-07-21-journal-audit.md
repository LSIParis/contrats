# Journal d'audit §6.9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Peupler `audit_logs` via un intercepteur global (mutations authentifiées réussies) avec chaîne de hash inviolable, et livrer un écran cockpit (MSP_ADMIN) pour consulter/filtrer + vérifier l'intégrité.

**Architecture:** Migration n°14 (pgcrypto + 2 fonctions `SECURITY DEFINER` : append verrouillé par tenant, verify). `AuditService.record` appelle l'append (best-effort, hors tx requête). `AuditInterceptor` global capture chaque mutation 2xx authentifiée. API `GET /v1/audit` + `/verify` (MSP_ADMIN). Écran `/audit`.

**Tech Stack:** NestJS (Express, SWC), Prisma + PostgreSQL RLS + pgcrypto, `unsafeUnscopedClient.$queryRaw` ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- `audit_logs` est **append-only** (REVOKE UPDATE/DELETE sur lsi_app, déjà en base) et **interdit aux CLIENT en lecture** (RLS `audit_logs_scope`).
- L'écriture d'audit ne lit JAMAIS acteur/tenant depuis une entrée client : tout vient de `req.session` (server-résolu).
- **Best-effort après succès** : la mutation est déjà commitée ; un échec d'audit est logué (console.error), il ne casse pas la requête.
- Chaîne de hash : `sha256(prevHash ‖ payload canonique)` en **hex 64 car.** ; timestamp canonicalisé en UTC (`(x AT TIME ZONE 'UTC')::text`) pour être indépendant du fuseau de session ; `before` toujours NULL dans cet increment.
- Rôle lecture : `assertRole(['MSP_ADMIN'])`. Enum Postgres = `"ActorKind"` (INTERNAL/CLIENT/SYSTEM).
- Migrations = SQL manuscrit dans un dossier numéroté (dernier = `00000000000013`), appliqué par `prisma migrate deploy` (service `migrate`). Pas de nouvelle colonne → pas de `prisma generate` requis.
- IDs `uuidv7`. Imports ESM `.js`.

---

### Task 1: Migration n°14 — pgcrypto + fonctions append/verify

**Files:**
- Create: `packages/persistence/prisma/migrations/00000000000014_audit_chain/migration.sql`
- Test: `apps/api/tests/isolation/audit-chain.test.ts`

**Interfaces:**
- Produces (SQL) : `app_append_audit(...) → text` et `app_verify_audit_chain(uuid) → uuid`, exécutables par lsi_app/webhook/scheduler.

- [ ] **Step 1: Écrire la migration SQL**

Créer `packages/persistence/prisma/migrations/00000000000014_audit_chain/migration.sql` :

```sql
-- §6.9 : chaîne d'audit inviolable (détectable). Deux fonctions SECURITY
-- DEFINER : append (sérialisé par tenant via verrou consultatif) et verify.
-- La table reste append-only (REVOKE UPDATE/DELETE, migration 4) ; une entrée
-- modifiée casse la chaîne, donc DÉTECTABLE.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_append_audit(
  p_id uuid, p_tenant_id uuid, p_customer_id uuid,
  p_actor_user_id uuid, p_actor_kind text, p_actor_ip text, p_actor_user_agent text,
  p_action text, p_resource_type text, p_resource_id uuid,
  p_after jsonb, p_request_id text, p_occurred_at timestamptz
) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev text;
  v_payload text;
  v_hash text;
BEGIN
  -- Sérialise les appends du même tenant : la chaîne ne forke jamais.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));
  SELECT hash INTO v_prev FROM audit_logs
    WHERE tenant_id = p_tenant_id
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;
  v_payload := coalesce(v_prev, '')
    || E'\n' || (p_occurred_at AT TIME ZONE 'UTC')::text
    || E'\n' || p_tenant_id::text
    || E'\n' || coalesce(p_customer_id::text, '')
    || E'\n' || coalesce(p_actor_user_id::text, '')
    || E'\n' || p_actor_kind
    || E'\n' || p_action
    || E'\n' || p_resource_type
    || E'\n' || coalesce(p_resource_id::text, '')
    || E'\n' || coalesce(p_after::text, '');
  v_hash := encode(digest(v_payload, 'sha256'), 'hex');
  INSERT INTO audit_logs (id, tenant_id, customer_id, actor_user_id, actor_kind,
    actor_ip, actor_user_agent, action, resource_type, resource_id,
    before, after, request_id, occurred_at, prev_hash, hash)
  VALUES (p_id, p_tenant_id, p_customer_id, p_actor_user_id, p_actor_kind::"ActorKind",
    p_actor_ip, p_actor_user_agent, p_action, p_resource_type, p_resource_id,
    NULL, p_after, p_request_id, p_occurred_at, v_prev, v_hash);
  RETURN v_hash;
END;
$$;

CREATE OR REPLACE FUNCTION app_verify_audit_chain(p_tenant_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  v_prev text := NULL;
  v_payload text;
  v_hash text;
BEGIN
  FOR r IN
    SELECT * FROM audit_logs WHERE tenant_id = p_tenant_id
    ORDER BY occurred_at ASC, id ASC
  LOOP
    IF coalesce(r.prev_hash, '') <> coalesce(v_prev, '') THEN
      RETURN r.id;  -- rupture de chaînage
    END IF;
    v_payload := coalesce(v_prev, '')
      || E'\n' || (r.occurred_at AT TIME ZONE 'UTC')::text
      || E'\n' || r.tenant_id::text
      || E'\n' || coalesce(r.customer_id::text, '')
      || E'\n' || coalesce(r.actor_user_id::text, '')
      || E'\n' || r.actor_kind::text
      || E'\n' || r.action
      || E'\n' || r.resource_type
      || E'\n' || coalesce(r.resource_id::text, '')
      || E'\n' || coalesce(r.after::text, '');
    v_hash := encode(digest(v_payload, 'sha256'), 'hex');
    IF v_hash <> r.hash THEN
      RETURN r.id;  -- hash altéré
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;  -- chaîne intègre
END;
$$;

REVOKE ALL ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) TO lsi_app, lsi_webhook, lsi_scheduler;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid) TO lsi_app, lsi_webhook, lsi_scheduler;
```

- [ ] **Step 2: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/audit-chain.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { unsafeUnscopedClient, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let fx: TwoCustomerFixture;
const db = unsafeUnscopedClient;

async function append(tenantId: string, action: string, after: unknown, actorUserId: string) {
  const rows = await db.$queryRaw<{ app_append_audit: string }[]>`
    SELECT app_append_audit(
      ${uuidv7()}::uuid, ${tenantId}::uuid, ${null}::uuid,
      ${actorUserId}::uuid, 'INTERNAL', ${null}::text, ${null}::text,
      ${action}, 'contract', ${null}::uuid,
      ${JSON.stringify(after)}::jsonb, ${null}::text, now()::timestamptz)`;
  return rows[0].app_append_audit;
}

beforeAll(async () => { fx = await seedTwoCustomers(); });

describe('chaîne d’audit', () => {
  test('deux appends chaînent et verify renvoie NULL (intègre)', async () => {
    const h1 = await append(fx.tenantId, 'A1', { x: 1 }, fx.adminUserId);
    const h2 = await append(fx.tenantId, 'A2', { x: 2 }, fx.adminUserId);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).not.toBe(h1);
    const rows = await db.$queryRaw<{ prev_hash: string | null; hash: string }[]>`
      SELECT prev_hash, hash FROM audit_logs WHERE tenant_id = ${fx.tenantId}::uuid ORDER BY occurred_at ASC, id ASC`;
    expect(rows.at(-1)!.prev_hash).toBe(rows.at(-2)!.hash); // chaînage
    const v = await db.$queryRaw<{ app_verify_audit_chain: string | null }[]>`
      SELECT app_verify_audit_chain(${fx.tenantId}::uuid)`;
    expect(v[0].app_verify_audit_chain).toBeNull();
  });

  test('une entrée au hash falsifié est détectée par verify', async () => {
    await append(fx.tenantId, 'A3', { x: 3 }, fx.adminUserId);
    // insertion directe d'une entrée dont le hash ne chaîne pas (lsi_app garde INSERT)
    const badId = uuidv7();
    await db.$executeRaw`
      INSERT INTO audit_logs (id, tenant_id, customer_id, actor_user_id, actor_kind,
        action, resource_type, occurred_at, prev_hash, hash)
      VALUES (${badId}::uuid, ${fx.tenantId}::uuid, ${null}::uuid, ${fx.adminUserId}::uuid, 'INTERNAL',
        'FORGED', 'contract', now()::timestamptz, 'deadbeef', ${'0'.repeat(64)})`;
    const v = await db.$queryRaw<{ app_verify_audit_chain: string | null }[]>`
      SELECT app_verify_audit_chain(${fx.tenantId}::uuid)`;
    expect(v[0].app_verify_audit_chain).toBe(badId);
  });
});
```

- [ ] **Step 3: Lancer le test — il échoue si la migration n'est pas appliquée**

Run: `pnpm --filter @lsi/api test -- audit-chain`
Expected (avant migration prise en compte) : FAIL (`function app_append_audit does not exist`). Le harness applique les migrations au démarrage ; si la migration est présente, il passe directement à PASS.

- [ ] **Step 4: Vérifier le vert + non-régression**

Run: `pnpm --filter @lsi/api test -- audit-chain`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/prisma/migrations/00000000000014_audit_chain apps/api/tests/isolation/audit-chain.test.ts
git commit -m "feat(db): migration 14 — chaîne d'audit (app_append_audit + app_verify_audit_chain, pgcrypto)"
```

---

### Task 2: AuditService + AuditInterceptor global

**Files:**
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/audit.interceptor.ts`
- Modify: `apps/api/src/app.module.ts` (provider + APP_INTERCEPTOR)
- Test: `apps/api/tests/isolation/audit-interceptor.test.ts`

**Interfaces:**
- Consumes: `unsafeUnscopedClient`, `uuidv7` de `@lsi/persistence`.
- Produces:
  - `AuditService.record(entry): Promise<void>` (best-effort ; entry = `{ tenantId, customerId, actorUserId, actorKind, actorIp, actorUserAgent, action, resourceType, resourceId, after, requestId, occurredAt }`).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/audit-interceptor.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, unsafeUnscopedClient, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
const db = unsafeUnscopedClient;

async function auditCount(tenantId: string, action?: string) {
  const rows = action
    ? await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM audit_logs WHERE tenant_id=${tenantId}::uuid AND action LIKE ${'%' + action + '%'}`
    : await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM audit_logs WHERE tenant_id=${tenantId}::uuid`;
  return Number(rows[0].n);
}
async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AU-${id.slice(-8)}`,
    title: 'Audit', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const asA = (m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', 'sess-am-a');

describe('intercepteur d’audit', () => {
  test('une mutation réussie (POST commentaire) produit une entrée d’audit', async () => {
    const c = await seedContract();
    const before = await auditCount(fx.tenantId);
    await asA('post', `/v1/contracts/${c}/comments`).send({ body: 'audité', visibility: 'INTERNAL' }).expect(201);
    const after = await auditCount(fx.tenantId);
    expect(after).toBe(before + 1);
    const rows = await db.$queryRaw<{ action: string; resource_type: string; actor_user_id: string }[]>`
      SELECT action, resource_type, actor_user_id FROM audit_logs WHERE tenant_id=${fx.tenantId}::uuid ORDER BY occurred_at DESC, id DESC LIMIT 1`;
    expect(rows[0].action).toMatch(/POST/);
    expect(rows[0].resource_type).toBe('contracts');
    expect(rows[0].actor_user_id).toBe(fx.amUserId);
  });

  test('une lecture (GET) ne produit aucune entrée', async () => {
    const c = await seedContract();
    const before = await auditCount(fx.tenantId);
    await asA('get', `/v1/contracts/${c}/comments`).expect(200);
    expect(await auditCount(fx.tenantId)).toBe(before);
  });
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/api test -- audit-interceptor`
Expected: FAIL (aucune entrée créée — intercepteur absent).

- [ ] **Step 3: Créer le service**

`apps/api/src/audit/audit.service.ts` :

```ts
import { Injectable } from '@nestjs/common';
import { unsafeUnscopedClient, uuidv7 } from '@lsi/persistence';

export interface AuditEntry {
  tenantId: string;
  customerId: string | null;
  actorUserId: string | null;
  actorKind: 'INTERNAL' | 'CLIENT' | 'SYSTEM';
  actorIp: string | null;
  actorUserAgent: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  after: unknown;
  requestId: string | null;
  occurredAt: Date;
}

@Injectable()
export class AuditService {
  /** Best-effort : n'échoue jamais l'appelant. */
  async record(e: AuditEntry): Promise<void> {
    try {
      await unsafeUnscopedClient.$queryRaw`
        SELECT app_append_audit(
          ${uuidv7()}::uuid, ${e.tenantId}::uuid, ${e.customerId}::uuid,
          ${e.actorUserId}::uuid, ${e.actorKind}::text, ${e.actorIp}::text, ${e.actorUserAgent}::text,
          ${e.action}::text, ${e.resourceType}::text, ${e.resourceId}::uuid,
          ${JSON.stringify(e.after ?? null)}::jsonb, ${e.requestId}::text, ${e.occurredAt}::timestamptz)`;
    } catch (err) {
      // L'action utilisateur est déjà commitée : on ne la casse pas.
      console.error('[audit] écriture échouée', err);
    }
  }
}
```

- [ ] **Step 4: Créer l'intercepteur**

`apps/api/src/audit/audit.interceptor.ts` :

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { AuditService } from './audit.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = /password|secret|token/i.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

/** resourceType = 1er segment métier après /v1 (en sautant 'portal'). */
function resourceTypeOf(path: string): string {
  const seg = path.split('?')[0].split('/').filter(Boolean); // ['v1','contracts',...]
  let i = seg.indexOf('v1');
  i = i < 0 ? 0 : i + 1;
  if (seg[i] === 'portal') i += 1;
  return seg[i] ?? 'unknown';
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req: any = ctx.switchToHttp().getRequest();
    const method: string = req.method;
    const session = req.session;
    const path: string = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const skip = !MUTATING.has(method) || !session || path === '/health' || path.startsWith('/v1/auth/');
    if (skip) return next.handle();
    return next.handle().pipe(tap({
      next: () => {
        const resId = typeof req.params?.id === 'string' && UUID_RE.test(req.params.id) ? req.params.id : null;
        void this.audit.record({
          tenantId: session.tenantId,
          customerId: null,
          actorUserId: session.userId ?? null,
          actorKind: session.scope?.actorKind ?? 'INTERNAL',
          actorIp: req.ip ?? null,
          actorUserAgent: (req.headers?.['user-agent'] as string) ?? null,
          action: `${method} ${req.route?.path ?? path}`,
          resourceType: resourceTypeOf(path),
          resourceId: resId,
          after: redact(req.body),
          requestId: (req.headers?.['x-request-id'] as string) ?? null,
          occurredAt: new Date(),
        });
      },
      // Sur erreur : pas d'audit (succès uniquement).
    }));
  }
}
```

- [ ] **Step 5: Câbler dans app.module.ts**

Ajouter les imports :

```ts
import { AuditService } from './audit/audit.service.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
```

Ajouter `AuditService` aux `providers`, et un second `APP_INTERCEPTOR` (à côté de `BigIntInterceptor`) :

```ts
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
```

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- audit-interceptor`
Expected: PASS (2/2).

- [ ] **Step 7: Non-régression large (l'intercepteur touche toutes les routes)**

Run: `pnpm --filter @lsi/api test`
Expected: PASS (aucune régression ; les mutations existantes produisent désormais des entrées d'audit, sans casser leurs assertions).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/audit apps/api/src/app.module.ts apps/api/tests/isolation/audit-interceptor.test.ts
git commit -m "feat(audit): AuditService + intercepteur global (mutations authentifiées 2xx, best-effort)"
```

---

### Task 3: API lecture — GET /v1/audit + /verify

**Files:**
- Create: `apps/api/src/audit/audit-read.service.ts`
- Create: `apps/api/src/audit/audit.controller.ts`
- Create: `apps/api/src/audit/dto/list-audit.dto.ts`
- Modify: `apps/api/src/app.module.ts` (controller + provider)
- Test: `apps/api/tests/isolation/audit-read.test.ts`

**Interfaces:**
- Consumes: `withScope` (lecture RLS-scopée), `unsafeUnscopedClient` (pour `app_verify_audit_chain` — SECURITY DEFINER, mais on passe le tenant du scope).
- Produces: `GET /v1/audit`, `GET /v1/audit/verify`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/audit-read.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, unsafeUnscopedClient, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
const db = unsafeUnscopedClient;
async function append(tenantId: string, action: string, actor: string) {
  await db.$queryRaw`SELECT app_append_audit(${uuidv7()}::uuid, ${tenantId}::uuid, ${null}::uuid,
    ${actor}::uuid, 'INTERNAL', ${null}::text, ${null}::text, ${action}::text, 'contract', ${null}::uuid,
    ${'{}'}::jsonb, ${null}::text, now()::timestamptz)`;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('lecture du journal d’audit', () => {
  test('MSP_ADMIN liste les entrées ; un non-admin → 403', async () => {
    await append(fx.tenantId, 'READ_TEST_1', fx.adminUserId);
    const res = await req('sess-admin', 'get', '/v1/audit').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    await req('sess-am', 'get', '/v1/audit').expect(403);
  });

  test('filtre par action', async () => {
    await append(fx.tenantId, 'NEEDLE_XYZ', fx.adminUserId);
    const res = await req('sess-admin', 'get', '/v1/audit?action=NEEDLE_XYZ').expect(200);
    expect(res.body.items.every((i: any) => i.action.includes('NEEDLE_XYZ'))).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  test('verify renvoie ok:true sur une chaîne saine', async () => {
    const res = await req('sess-admin', 'get', '/v1/audit/verify').expect(200);
    expect(res.body).toMatchObject({ ok: true, brokenAt: null });
  });
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- audit-read`
Expected: FAIL (routes absentes).

- [ ] **Step 3: Créer le DTO**

`apps/api/src/audit/dto/list-audit.dto.ts` :

```ts
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListAuditDto {
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsUUID('7') resourceId?: string;
  @IsOptional() @IsUUID('7') actorUserId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() from?: string; // ISO
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
```

- [ ] **Step 4: Créer le service de lecture**

`apps/api/src/audit/audit-read.service.ts` :

```ts
import { Injectable } from '@nestjs/common';
import { withScope, unsafeUnscopedClient, type Scope } from '@lsi/persistence';
import type { ListAuditDto } from './dto/list-audit.dto.js';

@Injectable()
export class AuditReadService {
  async list(scope: Scope, q: ListAuditDto) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return withScope(scope, async (tx) => {
      const where: any = {};
      if (q.resourceType) where.resourceType = q.resourceType;
      if (q.resourceId) where.resourceId = q.resourceId;
      if (q.actorUserId) where.actorUserId = q.actorUserId;
      if (q.action) where.action = { contains: q.action };
      if (q.from || q.to) where.occurredAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
      const items = await tx.auditLog.findMany({
        where, orderBy: { occurredAt: 'desc' }, take: limit, skip: offset,
        select: { id: true, occurredAt: true, actorUserId: true, actorKind: true, action: true,
          resourceType: true, resourceId: true, requestId: true, hash: true, prevHash: true, after: true },
      });
      return { items };
    });
  }

  /** Vérifie la chaîne du tenant du scope (fonction SECURITY DEFINER). */
  async verify(scope: Scope) {
    const rows = await unsafeUnscopedClient.$queryRaw<{ app_verify_audit_chain: string | null }[]>`
      SELECT app_verify_audit_chain(${scope.tenantId}::uuid)`;
    const brokenAt = rows[0]?.app_verify_audit_chain ?? null;
    return { ok: brokenAt === null, brokenAt };
  }
}
```

- [ ] **Step 5: Créer le contrôleur**

`apps/api/src/audit/audit.controller.ts` :

```ts
import { Controller, Get, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { AuditReadService } from './audit-read.service.js';
import { ListAuditDto } from './dto/list-audit.dto.js';

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditReadService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Query() q: ListAuditDto) {
    assertRole(session, ['MSP_ADMIN']);
    return this.audit.list(scope, q);
  }

  @Get('verify')
  verify(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertRole(session, ['MSP_ADMIN']);
    return this.audit.verify(scope);
  }
}
```

*(Note ordre des routes : `/v1/audit/verify` est un chemin statique distinct de `/v1/audit` — pas de collision de param.)*

- [ ] **Step 6: Câbler dans app.module.ts**

Imports :

```ts
import { AuditController } from './audit/audit.controller.js';
import { AuditReadService } from './audit/audit-read.service.js';
```

Ajouter `AuditController` aux `controllers` et `AuditReadService` aux `providers`.

- [ ] **Step 7: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- audit-read`
Expected: PASS (3/3).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/audit/audit-read.service.ts apps/api/src/audit/audit.controller.ts apps/api/src/audit/dto apps/api/src/app.module.ts apps/api/tests/isolation/audit-read.test.ts
git commit -m "feat(audit): API lecture GET /v1/audit (filtres, MSP_ADMIN) + /verify (intégrité chaîne)"
```

---

### Task 4: Frontend cockpit — écran /audit

**Files:**
- Create: `apps/web/src/features/audit/audit-page.tsx`
- Modify: `apps/web/src/app.tsx` (route `/audit`)
- Modify: `apps/web/src/shell/app-shell.tsx` (lien nav MSP_ADMIN)
- Modify: `apps/web/src/lib/labels.ts` (`actorKindLabel` si absent — sinon réutiliser)
- Test: `apps/web/src/test/audit-page.test.tsx`

**Interfaces:**
- Consumes: `apiGet` ; endpoints Task 3.
- Produces: écran `/audit` (tableau + filtres + bouton vérifier).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/audit-page.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditPage } from '../features/audit/audit-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AuditPage /></MemoryRouter></QueryClientProvider>);
}

const entry = { id: 'a1', occurredAt: '2026-07-21T10:00:00Z', actorUserId: 'u1', actorKind: 'INTERNAL', action: 'POST /v1/contracts/:id/submit', resourceType: 'contracts', resourceId: 'c1', requestId: null, hash: 'abcd', prevHash: null, after: {} };

test('affiche les entrées d’audit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [entry] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText(/POST \/v1\/contracts/)).toBeInTheDocument());
});

test('le bouton « Vérifier l’intégrité » affiche le résultat', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).includes('/verify') ? { ok: true, brokenAt: null } : { items: [entry] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Vérifier l.intégrité/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Vérifier l.intégrité/i }));
  await waitFor(() => expect(screen.getByText(/intègre/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/web test -- audit-page`
Expected: FAIL (module absent).

- [ ] **Step 3: Créer la page**

`apps/web/src/features/audit/audit-page.tsx` :

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';
import { Button } from '../../ui/button.js';

interface AuditItem {
  id: string; occurredAt: string; actorUserId: string | null; actorKind: string;
  action: string; resourceType: string; resourceId: string | null; requestId: string | null;
}

export function AuditPage() {
  const [resourceType, setResourceType] = useState('');
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; brokenAt: string | null } | null>(null);
  const q = useQuery({
    queryKey: ['audit', resourceType],
    queryFn: () => apiGet<{ items: AuditItem[] }>(`/v1/audit${resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : ''}`),
  });
  const verify = async () => setVerifyResult(await apiGet<{ ok: boolean; brokenAt: string | null }>(`/v1/audit/verify`));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Journal d'audit</h1>
        <Button onClick={verify}>Vérifier l'intégrité</Button>
      </div>
      {verifyResult && (
        <p className={`text-sm ${verifyResult.ok ? 'text-green-700' : 'text-red-600'}`}>
          {verifyResult.ok ? '✓ Chaîne intègre' : `⚠ Rupture détectée à l'entrée ${verifyResult.brokenAt}`}
        </p>
      )}
      <input
        value={resourceType} onChange={(e) => setResourceType(e.target.value)}
        placeholder="Filtrer par type de ressource (ex. contracts)"
        className="w-72 rounded border border-gray-300 p-2 text-sm"
      />
      <Card title="Entrées">
        {q.isLoading ? <Spinner /> : (
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500">
              <tr><th className="py-1">Date</th><th>Acteur</th><th>Action</th><th>Ressource</th></tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-1">{new Date(e.occurredAt).toLocaleString('fr-FR')}</td>
                  <td>{e.actorUserId ?? e.actorKind}</td>
                  <td className="font-mono text-xs">{e.action}</td>
                  <td>{e.resourceType}{e.resourceId ? ` · ${e.resourceId.slice(0, 8)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Route + lien nav**

Dans `apps/web/src/app.tsx` : importer `AuditPage` et ajouter une route `/audit` dans la zone interne (à côté de `/users`), suivant le même motif que les routes internes existantes.

Dans `apps/web/src/shell/app-shell.tsx` : ajouter, sous le lien « Utilisateurs » (même garde `me.data?.roles?.includes('MSP_ADMIN')`) :

```tsx
          {me.data?.roles?.includes('MSP_ADMIN') && <li><Link to="/audit">Audit</Link></li>}
```

- [ ] **Step 5: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- audit-page`
Expected: PASS (2/2).

- [ ] **Step 6: Build**

Run: `pnpm --filter @lsi/web build`
Expected: OK.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/audit apps/web/src/app.tsx apps/web/src/shell/app-shell.tsx apps/web/src/lib/labels.ts apps/web/src/test/audit-page.test.tsx
git commit -m "feat(web/cockpit): écran Journal d'audit (liste filtrable + vérification d'intégrité, MSP_ADMIN)"
```

---

## Self-Review

**Spec coverage :**
- §3 migration (pgcrypto + append + verify) → Task 1 ✅
- §4 AuditService + intercepteur global → Task 2 ✅ ; API lecture + verify → Task 3 ✅
- §5 écran cockpit → Task 4 ✅
- §6 sécurité (403 non-admin, chaîne détectable, GET non audité, best-effort) → tests Task 1/2/3 ✅

**Placeholders :** aucun code laissé en TODO. Task 4 Step 4 (route + nav) décrit précisément l'insertion en suivant les motifs existants (`/users`).

**Cohérence des types :** `app_append_audit`/`app_verify_audit_chain` (Task 1) appelées par `AuditService.record` (Task 2) et `AuditReadService.verify` (Task 3) avec les mêmes signatures ; l'intercepteur (Task 2) produit `action/resourceType/resourceId/after` consommés par la lecture (Task 3) et l'écran (Task 4). `payload` canonique **identique** entre append et verify (même ordre de champs, timestamp UTC) — condition de validité de la chaîne.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
