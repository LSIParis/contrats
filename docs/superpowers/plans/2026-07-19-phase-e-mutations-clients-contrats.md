# Phase E — Mutations #1 (Clients + création de contrat) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de créer/lister/consulter des clients (+ contacts) et de créer un contrat, débloquant le suivi d'échéance de bout en bout.

**Architecture:** Endpoints NestJS scopés et gardés par rôle. La création de client passe par une fonction SECURITY DEFINER bornée (`app_create_customer`) qui insère le client et, si le créateur est un account manager, sa ligne `customer_access` — puis le service **rafraîchit le scope de session** (re-résolu depuis `customer_access`) pour que l'AM voie immédiatement son client. Le front est un SPA React qui consomme ces endpoints via `useMutation`/`useQuery`.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL RLS, React 18, Vite 5, TanStack Query 5, class-validator, Vitest + Testing Library + supertest + Testcontainers.

## Global Constraints

- **Monorepo pnpm** ; front = `@lsi/web` sous `apps/web`. Node 22, pnpm 9.15.9. Runtime API en **SWC** (jamais tsx).
- **Sécurité non négociable** : tout endpoint est scopé par le `ScopeGuard` global (aucun `@Public()`). **404 (jamais 403) hors scope** pour l'existence d'une ressource (RM-30) ; **403** seulement pour un rôle insuffisant (`assertRole`) ; **409** sur conflit d'unicité. Data uniquement via `withScope` — SAUF la création de client, qui passe par `app_create_customer` (SECURITY DEFINER, sous `lsi_app`, aucun nouveau rôle bypass). Le front ne porte AUCUNE autorisation.
- **UI en français.** Interdit : `$queryRawUnsafe`/`$executeRawUnsafe` hors `packages/persistence/src/testing` (ESLint §13.3) — utiliser `$queryRaw` paramétré.
- **CI** (`pnpm lint` + `pnpm typecheck` + `pnpm test`) doit rester verte, `apps/web` inclus.
- **Pattern de test API** (imposé, cf. `apps/api/tests/isolation/idor.test.ts`) : `SessionService.put({ sessionId, userId, tenantId, roles, scope })` avec `internalScope(tenantId, [customerIds], userId)` / `adminScope(tenantId, userId)` ; requête authentifiée par l'en-tête `x-lsi-session: <sessionId>`.
- **Fixture** `seedTwoCustomers()` (de `@lsi/persistence/testing`) : `tenantId, amUserId, amEmail, amBUserId, adminUserId, customerA{id,...}, customerB{id,...}`. Les AM ont un portefeuille disjoint (A pour amUserId, B pour amBUserId).

---

## Structure de fichiers

**API**
- Create: `packages/persistence/prisma/migrations/00000000000012_create_customer/migration.sql`
- Create: `packages/persistence/src/customer-write.ts`
- Modify: `packages/persistence/src/index.ts` (exports)
- Create: `apps/api/src/customers/customers.service.ts`, `customers.controller.ts`, `dto/create-customer.dto.ts`, `dto/create-contact.dto.ts`
- Modify: `apps/api/src/app.module.ts`

**Front (`apps/web`)**
- Modify: `apps/web/src/lib/api.ts` (`apiPost`, `ApiError`)
- Create: `apps/web/src/ui/{field.tsx, input.tsx, select.tsx}`
- Create: `apps/web/src/features/customers/{customers-page.tsx, customer-detail-page.tsx, customer-new-page.tsx, add-contact-form.tsx}`
- Create: `apps/web/src/features/contracts/contract-new-page.tsx`
- Modify: `apps/web/src/app.tsx` (routes), `apps/web/src/shell/app-shell.tsx` (nav « Clients »)

---

## Task 1 : `POST /v1/customers` (création + auto-accès AM + rafraîchissement de scope)

**Files:**
- Create: `packages/persistence/prisma/migrations/00000000000012_create_customer/migration.sql`
- Create: `packages/persistence/src/customer-write.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.controller.ts`, `apps/api/src/customers/dto/create-customer.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/customers-create.test.ts`

**Interfaces:**
- Produces: `createCustomer(input)` (persistence) → `{ id: string }` ; lève `CustomerSirenConflict` sur SIREN dupliqué.
- Produces: `POST /v1/customers` → `{ id, name, siren, country }`. 403 rôle insuffisant, 409 SIREN dupliqué.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/customers-create.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope } from '@lsi/persistence';
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
    sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId),
  });
});

describe('POST /v1/customers', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).post('/v1/customers').send({ name: 'X' }).expect(401);
  });

  test('un AM crée un client et le voit dans la réponse (auto-accès + scope rafraîchi)', async () => {
    // La réponse 201 est LUE par le service sous le scope RAFRAÎCHI (le service
    // re-résout depuis customer_access après l'insert). Si le rafraîchissement
    // n'avait pas eu lieu, la relecture sous le scope de login (qui n'inclut
    // pas ce client neuf) échouerait — pas de 201 avec le bon corps. Ce test
    // ne dépend donc PAS des endpoints de lecture (Task 2).
    const create = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('x-lsi-session', 'sess-am-a')
      .send({ name: 'Nouvelle SARL', siren: '123456789', city: 'Lyon' })
      .expect(201);
    expect(create.body.id).toBeTruthy();
    expect(create.body.name).toBe('Nouvelle SARL');
  });

  test('un admin crée un client (all_customers, sans ligne d’accès) → 201', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('x-lsi-session', 'sess-admin')
      .send({ name: 'Admin Client SA' })
      .expect(201);
    expect(create.body.name).toBe('Admin Client SA');
  });

  test('SIREN dupliqué dans le tenant → 409', async () => {
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'A', siren: '999999999' }).expect(201);
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'B', siren: '999999999' }).expect(409);
  });

  test('SIREN mal formé → 400', async () => {
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'C', siren: '12' }).expect(400);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-create.test.ts`
Expected: FAIL (404 : route absente).

- [ ] **Step 3 : Migration `app_create_customer`**

```sql
-- packages/persistence/prisma/migrations/00000000000012_create_customer/migration.sql
--
-- Création d'un client. (§6.2)
--
-- La policy customers_scope a WITH CHECK (app_customer_in_scope(id)) : un
-- account manager ne peut pas insérer un client dont l'id neuf n'est pas encore
-- dans son scope (œuf/poule). Cette fonction SECURITY DEFINER bornée insère le
-- client ET, si demandé, la ligne customer_access du créateur — atomiquement.
-- Sous lsi_app, aucun nouveau rôle bypass. Le tenant vient du scope
-- server-résolu, jamais du client.
CREATE OR REPLACE FUNCTION app_create_customer(
  p_id uuid, p_tenant_id uuid, p_name text, p_legal_name text, p_siren text,
  p_vat_number text, p_address_line1 text, p_address_line2 text,
  p_postal_code text, p_city text, p_country text, p_notes text,
  p_creator_user_id uuid, p_grant_access boolean
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO customers (id, tenant_id, name, legal_name, siren, vat_number,
    address_line1, address_line2, postal_code, city, country, status, notes,
    created_at, updated_at)
  VALUES (p_id, p_tenant_id, p_name, p_legal_name, p_siren, p_vat_number,
    p_address_line1, p_address_line2, p_postal_code, p_city,
    COALESCE(p_country, 'FR'), 'ACTIVE', p_notes, now(), now());

  IF p_grant_access THEN
    INSERT INTO customer_access (tenant_id, user_id, customer_id, granted_by_user_id, granted_at)
    VALUES (p_tenant_id, p_creator_user_id, p_id, p_creator_user_id, now());
  END IF;

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION app_create_customer(uuid,uuid,text,text,text,text,text,text,text,text,text,text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_create_customer(uuid,uuid,text,text,text,text,text,text,text,text,text,text,uuid,boolean) TO lsi_app;
```

- [ ] **Step 4 : Helper de persistance**

```typescript
// packages/persistence/src/customer-write.ts
import { unsafeUnscopedClient } from './scoped-client.js';
import { uuidv7 } from './uuid.js';

/** SIREN déjà utilisé dans le tenant (contrainte UNIQUE(tenant_id, siren)). */
export class CustomerSirenConflict extends Error {}

export interface NewCustomerInput {
  tenantId: string;
  name: string;
  legalName?: string | null;
  siren?: string | null;
  vatNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  notes?: string | null;
  creatorUserId: string;
  /** true pour un AM (auto-affecté), false pour un admin (all_customers). */
  grantAccess: boolean;
}

export async function createCustomer(c: NewCustomerInput): Promise<{ id: string }> {
  const id = uuidv7();
  try {
    await unsafeUnscopedClient.$queryRaw`
      SELECT app_create_customer(
        ${id}::uuid, ${c.tenantId}::uuid, ${c.name}, ${c.legalName ?? null},
        ${c.siren ?? null}, ${c.vatNumber ?? null}, ${c.addressLine1 ?? null},
        ${c.addressLine2 ?? null}, ${c.postalCode ?? null}, ${c.city ?? null},
        ${c.country ?? 'FR'}, ${c.notes ?? null},
        ${c.creatorUserId}::uuid, ${c.grantAccess})`;
    return { id };
  } catch (e: any) {
    // La violation d'unicité SIREN remonte comme code Postgres 23505 (via P2010).
    // Seul SIREN est unique ici (l'id est un uuidv7, pas de collision).
    const code = e?.meta?.code ?? '';
    if (code === '23505' || String(e?.message ?? '').includes('23505')) {
      throw new CustomerSirenConflict('SIREN déjà utilisé pour ce tenant');
    }
    throw e;
  }
}
```

Ajouter à `packages/persistence/src/index.ts` :
```typescript
export { createCustomer, CustomerSirenConflict, type NewCustomerInput } from './customer-write.js';
```

- [ ] **Step 5 : DTO**

```typescript
// apps/api/src/customers/dto/create-customer.dto.ts
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(200)
  legalName?: string;

  /** SIREN : exactement 9 chiffres. Unique par tenant. */
  @IsOptional() @Matches(/^\d{9}$/, { message: 'siren doit comporter 9 chiffres' })
  siren?: string;

  @IsOptional() @IsString() @MaxLength(20)
  vatNumber?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressLine1?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressLine2?: string;

  @IsOptional() @IsString() @MaxLength(20)
  postalCode?: string;

  @IsOptional() @IsString() @MaxLength(120)
  city?: string;

  /** Code pays ISO à 2 lettres. Défaut FR côté base. */
  @IsOptional() @Length(2, 2)
  country?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}
```

- [ ] **Step 6 : Service (avec rafraîchissement de scope)**

```typescript
// apps/api/src/customers/customers.service.ts
import { ConflictException, Injectable } from '@nestjs/common';
import {
  withScope, createCustomer, CustomerSirenConflict, resolveUserScope,
  type Scope,
} from '@lsi/persistence';
import { SessionService, type Session } from '../auth/session.service.js';

@Injectable()
export class CustomersService {
  constructor(private readonly sessions: SessionService) {}

  async create(scope: Scope, session: Session, dto: import('./dto/create-customer.dto.js').CreateCustomerDto) {
    const isAdmin = session.roles.includes('MSP_ADMIN');
    let created: { id: string };
    try {
      created = await createCustomer({
        tenantId: session.tenantId,
        name: dto.name, legalName: dto.legalName ?? null, siren: dto.siren ?? null,
        vatNumber: dto.vatNumber ?? null, addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null, postalCode: dto.postalCode ?? null,
        city: dto.city ?? null, country: dto.country ?? null, notes: dto.notes ?? null,
        creatorUserId: session.userId, grantAccess: !isAdmin,
      });
    } catch (e) {
      if (e instanceof CustomerSirenConflict) throw new ConflictException('SIREN déjà utilisé');
      throw e;
    }

    // Le scope est résolu au LOGIN et mis en cache dans la session ; le client
    // neuf n'y figure pas. Pour un AM, on re-résout depuis customer_access
    // (qui contient désormais l'accès) et on rafraîchit la session — sinon il
    // ne verrait pas son propre client avant de se reconnecter (EC-17).
    let effective = scope;
    if (!isAdmin) {
      // Créer un client ne change PAS les rôles de l'utilisateur — seulement
      // son portefeuille. On ne met donc à jour QUE le scope de la session,
      // en gardant session.roles tel quel (évite d'importer RoleCode et la
      // frontière @prisma/client).
      const resolved = await resolveUserScope(session.tenantId, session.userId);
      if (resolved) {
        effective = resolved.scope;
        await this.sessions.put({ ...session, scope: resolved.scope });
      }
    }

    return withScope(effective, (tx) =>
      tx.customer.findUniqueOrThrow({
        where: { id: created.id },
        select: { id: true, name: true, siren: true, country: true },
      }),
    );
  }
}
```

- [ ] **Step 7 : Contrôleur**

```typescript
// apps/api/src/customers/customers.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';

@Controller('v1/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Body() dto: CreateCustomerDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.customers.create(scope, session, dto);
  }
}
```

Enregistrer dans `app.module.ts` : `CustomersController` (controllers), `CustomersService` (providers).

Vérifier : `resolveUserScope` et `RoleCode` importables (`resolveUserScope` de `@lsi/persistence`, `RoleCode` de `@prisma/client`). Vérifier l'export exact de `CurrentSession`/`assertRole` (dans `current-scope.decorator.ts`, comme `MeController`). Le `POST` renvoie 201 par défaut (Nest).

- [ ] **Step 8 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-create.test.ts`
Expected: PASS (5 tests). Le test est **auto-suffisant** : il ne dépend d'aucun endpoint de lecture (Task 2). La preuve du rafraîchissement de scope de l'AM tient dans la réponse 201 elle-même — le service relit le client sous le scope rafraîchi (`findUniqueOrThrow`), donc un 201 avec le bon corps prouve que le client neuf est visible pour l'AM ; un bug de rafraîchissement ferait échouer la relecture (pas de 201).

- [ ] **Step 9 : Commit**

```bash
git add packages/persistence/prisma/migrations/00000000000012_create_customer packages/persistence/src/customer-write.ts packages/persistence/src/index.ts apps/api/src/customers apps/api/src/app.module.ts apps/api/tests/isolation/customers-create.test.ts
git commit -m "feat(api): POST /v1/customers — création client (SECURITY DEFINER + auto-accès AM)"
```

---

## Task 2 : `GET /v1/customers` (liste) + `GET /v1/customers/:id` (fiche + contacts)

**Files:**
- Modify: `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.controller.ts`
- Test: `apps/api/tests/isolation/customers-read.test.ts`

**Interfaces:**
- Produces: `GET /v1/customers` → `{ items: [{ id, name, siren, country, status, contractCount }] }` (scopé, trié par nom).
- Produces: `GET /v1/customers/:id` → `{ customer: {…}, contacts: [{ id, firstName, lastName, email, phone, jobTitle, isPrimary }] }`. 404 hors scope.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/customers-read.test.ts
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
});

describe('GET /v1/customers', () => {
  test('scopé : l’AM de A voit A, pas B', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers').set('x-lsi-session', 'sess-am-a').expect(200);
    const ids = res.body.items.map((c: any) => c.id);
    expect(ids).toContain(fx.customerA.id);
    expect(ids).not.toContain(fx.customerB.id);
    expect(typeof res.body.items[0].contractCount).toBe('number');
  });
});

describe('GET /v1/customers/:id', () => {
  test('fiche du client de A', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${fx.customerA.id}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.customer.id).toBe(fx.customerA.id);
    expect(Array.isArray(res.body.contacts)).toBe(true);
  });

  test('IDOR : le client de B → 404 (jamais 403)', async () => {
    await request(app.getHttpServer())
      .get(`/v1/customers/${fx.customerB.id}`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-read.test.ts`
Expected: FAIL (404 : routes absentes).

- [ ] **Step 3 : Ajouter les méthodes au service**

Dans `customers.service.ts`, ajouter (importer `NotFoundException`) :

```typescript
  list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.customer.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, siren: true, country: true, status: true,
          _count: { select: { contracts: true } },
        },
      });
      return {
        items: rows.map((c) => ({
          id: c.id, name: c.name, siren: c.siren, country: c.country,
          status: c.status, contractCount: c._count.contracts,
        })),
      };
    });
  }

  findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id },
        select: {
          id: true, name: true, legalName: true, siren: true, vatNumber: true,
          addressLine1: true, addressLine2: true, postalCode: true, city: true,
          country: true, status: true,
        },
      });
      if (!customer) throw new NotFoundException('Client introuvable');
      const contacts = await tx.customerContact.findMany({
        where: { customerId: id },
        orderBy: [{ isPrimary: 'desc' }, { lastName: 'asc' }],
        select: {
          id: true, firstName: true, lastName: true, email: true,
          phone: true, jobTitle: true, isPrimary: true,
        },
      });
      return { customer, contacts };
    });
  }
```

- [ ] **Step 4 : Ajouter les routes au contrôleur**

```typescript
import { Get, Param, ParseUUIDPipe } from '@nestjs/common';
// … dans la classe :
  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.customers.list(scope);
  }

  @Get(':id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(scope, id);
  }
```

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-read.test.ts tests/isolation/customers-create.test.ts`
Expected: PASS (les deux fichiers).

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/customers apps/api/tests/isolation/customers-read.test.ts
git commit -m "feat(api): GET /v1/customers (liste scopée) + /:id (fiche + contacts)"
```

---

## Task 3 : `POST /v1/customers/:id/contacts`

**Files:**
- Modify: `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.controller.ts`
- Create: `apps/api/src/customers/dto/create-contact.dto.ts`
- Test: `apps/api/tests/isolation/customers-contacts.test.ts`

**Interfaces:**
- Produces: `POST /v1/customers/:id/contacts` → le contact créé `{ id, firstName, lastName, email, isPrimary }`. Scopé (404 hors scope), 403 rôle insuffisant, 409 email dupliqué pour ce client.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/customers-contacts.test.ts
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
});

describe('POST /v1/customers/:id/contacts', () => {
  test('ajoute un contact au client de A', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'Jean', lastName: 'Dupont', email: 'jd@a.fr', isPrimary: true })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.email).toBe('jd@a.fr');
  });

  test('email dupliqué pour ce client → 409', async () => {
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'A', lastName: 'B', email: 'dup@a.fr' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'C', lastName: 'D', email: 'dup@a.fr' }).expect(409);
  });

  test('IDOR : ajouter un contact au client de B → 404', async () => {
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerB.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'X', lastName: 'Y', email: 'xy@b.fr' }).expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-contacts.test.ts`
Expected: FAIL (404 : route absente).

- [ ] **Step 3 : DTO**

```typescript
// apps/api/src/customers/dto/create-contact.dto.ts
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateContactDto {
  @IsString() @MaxLength(120) firstName!: string;
  @IsString() @MaxLength(120) lastName!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) jobTitle?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
```

- [ ] **Step 4 : Méthode service**

```typescript
import { uuidv7 } from '@lsi/persistence';
// … dans CustomersService :
  async addContact(scope: Scope, customerId: string, dto: CreateContactDto) {
    return withScope(scope, async (tx) => {
      // Le client doit être dans le scope, sinon 404 (RLS l'a déjà masqué).
      const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, tenantId: true } });
      if (!c) throw new NotFoundException('Client introuvable');
      try {
        return await tx.customerContact.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId,
            firstName: dto.firstName, lastName: dto.lastName, email: dto.email,
            phone: dto.phone ?? null, jobTitle: dto.jobTitle ?? null,
            isPrimary: dto.isPrimary ?? false,
            createdAt: new Date(), updatedAt: new Date(),
          },
          select: { id: true, firstName: true, lastName: true, email: true, isPrimary: true },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') throw new ConflictException('Un contact avec cet email existe déjà pour ce client');
        throw e;
      }
    });
  }
```

(Importer `CreateContactDto`, `ConflictException`, `NotFoundException`, `uuidv7`.)

- [ ] **Step 5 : Route contrôleur**

```typescript
  @Post(':id/contacts')
  addContact(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.customers.addContact(scope, id, dto);
  }
```

- [ ] **Step 6 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/customers-contacts.test.ts && pnpm exec vitest run`
Expected: PASS (contacts 3/3) puis suite complète verte.

- [ ] **Step 7 : Commit**

```bash
git add apps/api/src/customers apps/api/tests/isolation/customers-contacts.test.ts
git commit -m "feat(api): POST /v1/customers/:id/contacts (scopé, 409 email dupliqué)"
```

---

## Task 4 : Front — `apiPost` + primitives de formulaire

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/ui/field.tsx`, `apps/web/src/ui/input.tsx`, `apps/web/src/ui/select.tsx`
- Test: `apps/web/src/test/api-post.test.ts`

**Interfaces:**
- Produces: `apiPost<T>(path, body): Promise<T>` — POST JSON same-origin ; 401 → `Unauthorized` ; non-ok → `ApiError(status, message)` (message extrait du corps NestJS `{ message }`). `ApiError` exporté.
- Produces: `<Field label htmlFor error?>`, `<Input>`, `<Select>` (primitives Tailwind).

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/web/src/test/api-post.test.ts
import { apiPost, ApiError, Unauthorized } from '../lib/api.js';

test('POST réussi renvoie le JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } })));
  await expect(apiPost('/v1/customers', { name: 'X' })).resolves.toEqual({ id: 'c1' });
});

test('401 → Unauthorized', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  await expect(apiPost('/v1/customers', {})).rejects.toBeInstanceOf(Unauthorized);
});

test('409 → ApiError avec le message du serveur', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ statusCode: 409, message: 'SIREN déjà utilisé' }), {
      status: 409, headers: { 'content-type': 'application/json' } })));
  await expect(apiPost('/v1/customers', {})).rejects.toMatchObject({ status: 409, message: 'SIREN déjà utilisé' });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/api-post.test.ts`
Expected: FAIL (`apiPost`/`ApiError` absents).

- [ ] **Step 3 : Implémenter**

Ajouter à `apps/web/src/lib/api.ts` :
```typescript
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
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
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
```

```tsx
// apps/web/src/ui/field.tsx
import type { ReactNode } from 'react';
export function Field({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">{label}</label>
      {children}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

```tsx
// apps/web/src/ui/input.tsx
import type { InputHTMLAttributes } from 'react';
export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`w-full rounded border px-3 py-1.5 text-sm ${className}`} {...props} />;
}
```

```tsx
// apps/web/src/ui/select.tsx
import type { SelectHTMLAttributes } from 'react';
export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`w-full rounded border px-3 py-1.5 text-sm ${className}`} {...props} />;
}
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/api-post.test.ts` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5 : Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/ui apps/web/src/test/api-post.test.ts
git commit -m "feat(web): apiPost + ApiError + primitives de formulaire (Field/Input/Select)"
```

---

## Task 5 : Front — écrans liste et fiche client + nav

**Files:**
- Create: `apps/web/src/features/customers/customers-page.tsx`, `apps/web/src/features/customers/customer-detail-page.tsx`
- Modify: `apps/web/src/app.tsx`, `apps/web/src/shell/app-shell.tsx`
- Test: `apps/web/src/test/customers-page.test.tsx`

**Interfaces:**
- Produces: `<CustomersPage/>` (route `/customers`), `<CustomerDetailPage/>` (route `/customers/:id`), nav « Clients ».

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/customers-page.test.tsx
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { CustomersPage } from '../features/customers/customers-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><CustomersPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche les clients renvoyés par l’API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ items: [{ id: 'c1', name: 'Dupont SAS', siren: '123456789', country: 'FR', status: 'ACTIVE', contractCount: 3 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
  wrap();
  await waitFor(() => expect(screen.getByText('Dupont SAS')).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Dupont SAS/ })).toHaveAttribute('href', '/customers/c1');
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/customers-page.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter les écrans**

```tsx
// apps/web/src/features/customers/customers-page.tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

interface CustomerRow { id: string; name: string; siren: string | null; country: string; contractCount: number; }

export function CustomersPage() {
  const q = useQuery({ queryKey: ['customers'], queryFn: () => apiGet<{ items: CustomerRow[] }>('/v1/customers') });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Link to="/customers/new" className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">Nouveau client</Link>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucun client. Créez-en un pour commencer.</p>
      ) : (
        <Table head={<tr><th className="py-2">Nom</th><th>SIREN</th><th>Contrats</th></tr>}>
          {q.data.items.map((c) => (
            <tr key={c.id} className="border-b hover:bg-gray-50">
              <td className="py-2"><Link to={`/customers/${c.id}`} className="text-lsi hover:underline">{c.name}</Link></td>
              <td>{c.siren ?? '—'}</td>
              <td>{c.contractCount}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
```

```tsx
// apps/web/src/features/customers/customer-detail-page.tsx
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';

interface Contact { id: string; firstName: string; lastName: string; email: string; phone: string | null; jobTitle: string | null; isPrimary: boolean; }
interface CustomerDetail {
  customer: { id: string; name: string; siren: string | null; city: string | null; country: string; status: string };
  contacts: Contact[];
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => apiGet<CustomerDetail>(`/v1/customers/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Client introuvable.</p>;
  const { customer, contacts } = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{customer.name}</h1>
          <p className="text-sm text-gray-500">{customer.siren ? `SIREN ${customer.siren} · ` : ''}{customer.city ?? ''} ({customer.country})</p>
        </div>
        <Link to={`/contracts/new?customerId=${customer.id}`} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">Nouveau contrat</Link>
      </div>
      <Card title="Contacts">
        {contacts.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun contact.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {contacts.map((c) => (
              <li key={c.id} className="flex justify-between">
                <span>{c.firstName} {c.lastName}{c.isPrimary ? ' (principal)' : ''}</span>
                <span className="text-gray-500">{c.email}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4 : Router + nav**

Dans `app.tsx`, importer et ajouter les routes sous `<AppShell/>` :
```tsx
<Route path="/customers" element={<CustomersPage />} />
<Route path="/customers/:id" element={<CustomerDetailPage />} />
```
Dans `app-shell.tsx`, ajouter dans la `<ul>` de nav, avant « Contrats » :
```tsx
<li><Link to="/customers">Clients</Link></li>
```

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/customers-page.test.tsx` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): écrans liste + fiche client, nav Clients"
```

---

## Task 6 : Front — création de client + ajout de contact

**Files:**
- Create: `apps/web/src/features/customers/customer-new-page.tsx`, `apps/web/src/features/customers/add-contact-form.tsx`
- Modify: `apps/web/src/features/customers/customer-detail-page.tsx` (intégrer `AddContactForm`), `apps/web/src/app.tsx` (route `/customers/new`)
- Test: `apps/web/src/test/customer-new.test.tsx`

**Interfaces:**
- Produces: `<CustomerNewPage/>` (route `/customers/new`), `<AddContactForm customerId onDone/>`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/customer-new.test.tsx
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomerNewPage } from '../features/customers/customer-new-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/customers/new']}>
        <Routes>
          <Route path="/customers/new" element={<CustomerNewPage />} />
          <Route path="/customers/:id" element={<div>Fiche client</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('crée un client et redirige vers sa fiche', async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: 'c9', name: 'Test SARL', siren: null, country: 'FR' }),
      { status: 201, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  wrap();
  await userEvent.type(screen.getByLabelText(/Nom/), 'Test SARL');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText('Fiche client')).toBeInTheDocument());
  // Le POST est bien parti vers /v1/customers avec le nom.
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/customers'));
  expect(call).toBeTruthy();
});

test('affiche l’erreur API (SIREN dupliqué)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ statusCode: 409, message: 'SIREN déjà utilisé' }),
      { status: 409, headers: { 'content-type': 'application/json' } })));
  wrap();
  await userEvent.type(screen.getByLabelText(/Nom/), 'Doublon');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText(/SIREN déjà utilisé/)).toBeInTheDocument());
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/customer-new.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter le formulaire de création**

```tsx
// apps/web/src/features/customers/customer-new-page.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';

interface CreatedCustomer { id: string; name: string; }

export function CustomerNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', siren: '', addressLine1: '', postalCode: '', city: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { name: form.name.trim() };
      for (const k of ['siren', 'addressLine1', 'postalCode', 'city'] as const) {
        if (form[k].trim()) body[k] = form[k].trim();
      }
      return apiPost<CreatedCustomer>('/v1/customers', body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      nav(`/customers/${c.id}`);
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <form
      className="max-w-lg space-y-4"
      onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) m.mutate(); }}
    >
      <h1 className="text-xl font-semibold">Nouveau client</h1>
      <Field label="Nom" htmlFor="name"><Input id="name" value={form.name} onChange={set('name')} required /></Field>
      <Field label="SIREN (9 chiffres, optionnel)" htmlFor="siren"><Input id="siren" value={form.siren} onChange={set('siren')} /></Field>
      <Field label="Adresse" htmlFor="addr"><Input id="addr" value={form.addressLine1} onChange={set('addressLine1')} /></Field>
      <div className="flex gap-3">
        <Field label="Code postal" htmlFor="cp"><Input id="cp" value={form.postalCode} onChange={set('postalCode')} /></Field>
        <Field label="Ville" htmlFor="city"><Input id="city" value={form.city} onChange={set('city')} /></Field>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!form.name.trim() || m.isPending}
        className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50"
      >
        {m.isPending ? 'Création…' : 'Créer le client'}
      </button>
    </form>
  );
}
```

- [ ] **Step 4 : Formulaire d'ajout de contact + intégration fiche**

```tsx
// apps/web/src/features/customers/add-contact-form.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';

export function AddContactForm({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', isPrimary: false });
  const set = (k: 'firstName' | 'lastName' | 'email') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => apiPost(`/v1/customers/${customerId}/contacts`, {
      firstName: form.firstName.trim(), lastName: form.lastName.trim(),
      email: form.email.trim(), isPrimary: form.isPrimary,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customerId] });
      setForm({ firstName: '', lastName: '', email: '', isPrimary: false });
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.firstName.trim() && form.lastName.trim() && form.email.trim();

  return (
    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <Field label="Prénom" htmlFor="cf"><Input id="cf" value={form.firstName} onChange={set('firstName')} /></Field>
      <Field label="Nom" htmlFor="cl"><Input id="cl" value={form.lastName} onChange={set('lastName')} /></Field>
      <Field label="Email" htmlFor="ce"><Input id="ce" type="email" value={form.email} onChange={set('email')} /></Field>
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} /> Principal</label>
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-3 py-1.5 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">Ajouter</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}
```

Dans `customer-detail-page.tsx`, importer `AddContactForm` et l'ajouter dans la carte « Contacts », sous la liste :
```tsx
<AddContactForm customerId={customer.id} />
```

- [ ] **Step 5 : Route**

Dans `app.tsx`, ajouter (AVANT la route `/customers/:id` pour que `/customers/new` ne soit pas capturé comme un `:id`) :
```tsx
<Route path="/customers/new" element={<CustomerNewPage />} />
```
(React Router v6 privilégie les segments statiques, mais garder `/new` avant `/:id` est plus sûr et lisible.)

- [ ] **Step 6 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test src/test/customer-new.test.tsx` puis `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck`
Expected: PASS (toute la suite front) + typecheck clean.

- [ ] **Step 7 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): création de client + ajout de contact"
```

---

## Task 7 : Front — création de contrat

**Files:**
- Create: `apps/web/src/features/contracts/contract-new-page.tsx`
- Modify: `apps/web/src/app.tsx` (route `/contracts/new` AVANT `/contracts/:id`)
- Test: `apps/web/src/test/contract-new.test.tsx`

**Interfaces:**
- Produces: `<ContractNewPage/>` (route `/contracts/new`) — sélecteur de client (depuis `GET /v1/customers`, pré-rempli si `?customerId=`), champs métadonnées, montant en euros → centimes, POST `/v1/contracts`, redirection vers `/contracts/:id`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/contract-new.test.tsx
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractNewPage } from '../features/contracts/contract-new-page.js';

function wrap(entry = '/contracts/new?customerId=c1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/contracts/new" element={<ContractNewPage />} />
          <Route path="/contracts/:id" element={<div>Fiche contrat</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('crée un contrat (montant € → centimes) et redirige', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/v1/customers')) {
      return new Response(JSON.stringify({ items: [{ id: 'c1', name: 'Dupont SAS', siren: null, country: 'FR', contractCount: 0 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // POST /v1/contracts
    const body = JSON.parse(String(init?.body));
    // 1500,50 € → 150050 centimes
    expect(body.amountCents).toBe(150050);
    expect(body.customerId).toBe('c1');
    return new Response(JSON.stringify({ id: 'k1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap();
  await waitFor(() => expect(screen.getByDisplayValue('Dupont SAS')).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText(/Titre/), 'Maintenance 2026');
  await userEvent.type(screen.getByLabelText(/Montant/), '1500,50');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText('Fiche contrat')).toBeInTheDocument());
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/contract-new.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter**

```tsx
// apps/web/src/features/contracts/contract-new-page.tsx
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';

interface CustomerRow { id: string; name: string; }

/** « 1500,50 » ou « 1500.50 » → 150050 centimes. Vide → undefined. */
function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;
const FREQ = ['MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF'] as const;

export function ContractNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const custs = useQuery({ queryKey: ['customers'], queryFn: () => apiGet<{ items: CustomerRow[] }>('/v1/customers') });
  const [form, setForm] = useState({
    customerId: params.get('customerId') ?? '',
    title: '', category: 'MAINTENANCE', startDate: '', endDate: '',
    noticePeriodDays: '', amount: '', billingFrequency: 'MONTHLY',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        customerId: form.customerId, title: form.title.trim(), category: form.category,
        billingFrequency: form.billingFrequency,
      };
      if (form.startDate) body.startDate = form.startDate;
      if (form.endDate) body.endDate = form.endDate;
      if (form.noticePeriodDays.trim()) body.noticePeriodDays = Number(form.noticePeriodDays);
      const cents = eurosToCents(form.amount);
      if (cents !== undefined) body.amountCents = cents;
      return apiPost<{ id: string }>('/v1/contracts', body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`/contracts/${c.id}`);
    },
  });

  if (custs.isLoading) return <Spinner />;
  const customers = custs.data?.items ?? [];
  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.customerId && form.title.trim();

  return (
    <form className="max-w-lg space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <h1 className="text-xl font-semibold">Nouveau contrat</h1>
      <Field label="Client" htmlFor="cust">
        <Select id="cust" value={form.customerId} onChange={set('customerId')} required>
          <option value="">— choisir —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Titre" htmlFor="title"><Input id="title" value={form.title} onChange={set('title')} required /></Field>
      <Field label="Catégorie" htmlFor="cat">
        <Select id="cat" value={form.category} onChange={set('category')}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <div className="flex gap-3">
        <Field label="Date de début" htmlFor="sd"><Input id="sd" type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="Date de fin" htmlFor="ed"><Input id="ed" type="date" value={form.endDate} onChange={set('endDate')} /></Field>
      </div>
      <div className="flex gap-3">
        <Field label="Préavis (jours)" htmlFor="np"><Input id="np" type="number" min="0" value={form.noticePeriodDays} onChange={set('noticePeriodDays')} /></Field>
        <Field label="Montant (€)" htmlFor="amt"><Input id="amt" value={form.amount} onChange={set('amount')} placeholder="1500,00" /></Field>
      </div>
      <Field label="Facturation" htmlFor="bf">
        <Select id="bf" value={form.billingFrequency} onChange={set('billingFrequency')}>
          {FREQ.map((f) => <option key={f} value={f}>{f}</option>)}
        </Select>
      </Field>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50">
        {m.isPending ? 'Création…' : 'Créer le contrat'}
      </button>
    </form>
  );
}
```

- [ ] **Step 4 : Route**

Dans `app.tsx`, ajouter AVANT `/contracts/:id` :
```tsx
<Route path="/contracts/new" element={<ContractNewPage />} />
```

- [ ] **Step 5 : Lancer, vérifier le succès + suite complète**

Run: `pnpm --filter @lsi/web test src/test/contract-new.test.tsx` puis `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck`
Expected: PASS (toute la suite front) + typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): création de contrat (sélecteur client, € → centimes)"
```

---

## Clôture

- [ ] **Suite complète** : `cd apps/api && pnpm exec vitest run` (API, incl. `customers-*`) puis `pnpm --filter @lsi/web test` — tout vert.
- [ ] **CI locale** : depuis la racine, `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] **Déploiement** : merger sur `main` → CI construit l'image → redéployer la stack Portainer 111 (préserver l'env live, cf. mémoire `redeploy-portainer` ; relogin Portainer si le JWT a expiré). Le job `migrate` applique la migration 12. Vérifier en prod : créer un client puis un contrat depuis le cockpit, confirmer qu'il apparaît dans la liste et que ses rappels se matérialisent au balayage.
