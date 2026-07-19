# Phase E — Workflow de validation + signataires — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le workflow de validation interne réellement correct — signataires définissables, `contract_approvals` persistés (RM-10 appliqué), contenu requis pour soumettre (RM-11), réouverture d'un approuvé à l'édition, et boutons de workflow côté front.

**Architecture:** Une règle de domaine ajoutée (contenu requis pour soumettre) ; `applyEvent` (service) persiste désormais les enregistrements d'approbation ; `allowedActions`/`findOne` chargent les vrais signataires + le statut d'approbation ; endpoints signataires ; UI de workflow pilotée par `allowed-actions` + rôle + « pas le soumetteur ».

**Tech Stack:** NestJS 10, Prisma 5, domaine TS pur, React 18, TanStack Query 5, Vitest + Testing Library + supertest + Testcontainers.

## Global Constraints

- **Monorepo pnpm** ; front = `@lsi/web`. Node 22, pnpm 9.15.9. Runtime API en **SWC** (jamais tsx).
- **Sécurité** : tout endpoint scopé par le `ScopeGuard` global (aucun `@Public()`). **404 (jamais 403) hors scope** (RM-30) ; **403** rôle insuffisant (`assertRole`) ; **409** transition/règle métier invalide (via le domaine → `ConflictException`) ; **422** non utilisé ici (le contenu-requis passe par le domaine → 409). Data via `withScope`. Le front ne porte AUCUNE autorisation.
- **RM-10** : soumetteur ≠ validateur — appliqué par le domaine (`APPROVE`/`REQUEST_CHANGES` lèvent si `submittedByUserId === actorUserId`) ET le CHECK base `decided_by <> submitted_by`.
- **Rôles** : soumettre/annuler = MSP_ADMIN/ACCOUNT_MANAGER ; approuver/demander modifs = MSP_ADMIN/LEGAL_REVIEWER (déjà en place dans `contracts.controller.ts`).
- **UI en français.** Interdit `$queryRawUnsafe`/`$executeRawUnsafe` hors testing. CI (`lint`+`typecheck`+`test`) verte.
- **Pattern de test API** : `SessionService.put({ sessionId, userId, tenantId, roles, scope })` + en-tête `x-lsi-session`. Fixture `seedTwoCustomers()` : contrats DRAFT en `fx.customerA.contractId`/`fx.customerB.contractId` ; utilisateurs `fx.amUserId`, `fx.amBUserId`, `fx.adminUserId`.

---

## Structure de fichiers

**Domaine**
- Modify: `packages/domain/src/contract/state-machine.ts` (garde SUBMIT + `allowedEvents`)
- Test: `packages/domain/tests/submit-requires-content.test.ts`

**API**
- Create: `apps/api/src/contracts/dto/add-signer.dto.ts`, `apps/api/src/contracts/signers.service.ts`, `apps/api/src/contracts/signers.controller.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts` (`applyEvent` approbations ; `allowedActions` signataires ; `findOne` enrichi), `apps/api/src/contracts/content.service.ts` (RM-11), `apps/api/src/app.module.ts`

**Front (`apps/web`)**
- Create: `apps/web/src/features/contracts/signers-block.tsx`, `apps/web/src/features/contracts/workflow-actions.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Modify: `apps/web/src/lib/api.ts` (`apiDelete` si nécessaire)

---

## Task 1 : Domaine — contenu requis pour soumettre (RM-11)

**Files:**
- Modify: `packages/domain/src/contract/state-machine.ts`
- Test: `packages/domain/tests/submit-requires-content.test.ts`

**Interfaces:**
- Produces: `applyEvent(snapshot, {type:'SUBMIT_FOR_REVIEW', actorUserId}, now)` lève `BusinessRuleError('…contenu…','RM-11')` si `currentVersionId` est nul ; `allowedEvents(snapshot)` n'inclut `SUBMIT_FOR_REVIEW` que si `currentVersionId` est présent.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// packages/domain/tests/submit-requires-content.test.ts
import { describe, test, expect } from 'vitest';
import { applyEvent, allowedEvents, BusinessRuleError, type ContractSnapshot } from '../src/index.js';

function draft(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    id: 'c1', type: 'MAIN', status: 'DRAFT',
    startDate: new Date('2026-07-01'), endDate: null, noticePeriodDays: null,
    currentVersionId: 'v1', approvedVersionId: null, submittedByUserId: null,
    hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
    openAmendmentExists: false, hasSignedSuccessor: false,
    signedAt: null, activatedAt: null, terminatedAt: null,
    ...over,
  };
}

describe('RM-11 — contenu requis pour soumettre', () => {
  test('sans currentVersionId, SUBMIT lève une BusinessRuleError', () => {
    expect(() => applyEvent(draft({ currentVersionId: null }), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, new Date()))
      .toThrow(BusinessRuleError);
  });

  test('sans currentVersionId, allowedEvents ne liste pas SUBMIT_FOR_REVIEW', () => {
    expect(allowedEvents(draft({ currentVersionId: null }))).not.toContain('SUBMIT_FOR_REVIEW');
  });

  test('avec currentVersionId + signataires + date, SUBMIT est autorisé et passe à IN_REVIEW', () => {
    expect(allowedEvents(draft())).toContain('SUBMIT_FOR_REVIEW');
    const next = applyEvent(draft(), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, new Date());
    expect(next.status).toBe('IN_REVIEW');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd packages/domain && pnpm exec vitest run tests/submit-requires-content.test.ts`
Expected: FAIL (le 1er test ne lève pas, le 2e liste SUBMIT).

- [ ] **Step 3 : Ajouter la règle**

Dans `state-machine.ts`, cas `SUBMIT_FOR_REVIEW`, APRÈS la vérification `if (!c.startDate) …` et AVANT le `return { ...c, status: 'IN_REVIEW', … }` :
```typescript
      if (!c.currentVersionId) {
        throw new BusinessRuleError(
          'Le contrat doit avoir un contenu rédigé avant d’être soumis.',
          'RM-11',
        );
      }
```
Dans `allowedEvents`, le `case 'SUBMIT_FOR_REVIEW':` — ajouter la condition finale :
```typescript
      case 'SUBMIT_FOR_REVIEW':
        return c.hasLsiSigner && c.hasClientSigner && c.hasRequiredAttachments && !!c.startDate && !!c.currentVersionId;
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd packages/domain && pnpm exec vitest run tests/submit-requires-content.test.ts && pnpm exec vitest run`
Expected: PASS (nouveau fichier + toute la suite domaine, aucune régression).

- [ ] **Step 5 : Commit**

```bash
git add packages/domain/src/contract/state-machine.ts packages/domain/tests/submit-requires-content.test.ts
git commit -m "feat(domain): contenu requis avant soumission (RM-11)"
```

---

## Task 2 : API — signataires (`POST` / `DELETE …/signers`)

**Files:**
- Create: `apps/api/src/contracts/dto/add-signer.dto.ts`, `apps/api/src/contracts/signers.service.ts`, `apps/api/src/contracts/signers.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/signers.test.ts`

**Interfaces:**
- Produces: `POST /v1/contracts/:id/signers` → le signataire créé `{ id, party, fullName, email, signingOrder }`. `DELETE /v1/contracts/:id/signers/:signerId` → 204. Scopés, 403 rôle, 404 hors scope, 409 email dupliqué, 409 statut non éditable.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/signers.test.ts
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
  await sessions.put({
    sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('signataires', () => {
  test('ajoute puis supprime un signataire', async () => {
    const add = await request(app.getHttpServer())
      .post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'LSI', fullName: 'Marc D.', email: 'marc@lsi.fr', signingOrder: 0 }).expect(201);
    expect(add.body.party).toBe('LSI');
    await request(app.getHttpServer())
      .delete(`/v1/contracts/${fx.customerA.contractId}/signers/${add.body.id}`).set('x-lsi-session', 'sess-am-a').expect(204);
  });

  test('email dupliqué sur le contrat → 409', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'CLIENT', fullName: 'A', email: 'dup@x.fr' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'CLIENT', fullName: 'B', email: 'dup@x.fr' }).expect(409);
  });

  test('rôle insuffisant → 403', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-tech')
      .send({ party: 'LSI', fullName: 'X', email: 'x@x.fr' }).expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerB.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'LSI', fullName: 'X', email: 'y@y.fr' }).expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signers.test.ts`
Expected: FAIL (404, routes absentes).

- [ ] **Step 3 : DTO**

```typescript
// apps/api/src/contracts/dto/add-signer.dto.ts
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class AddSignerDto {
  @IsEnum(['LSI', 'CLIENT']) party!: 'LSI' | 'CLIENT';
  @IsString() @MaxLength(200) fullName!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsInt() @Min(0) @Max(20) signingOrder?: number;
  @IsOptional() @IsUUID('7') contactId?: string;
}
```

- [ ] **Step 4 : Service**

```typescript
// apps/api/src/contracts/signers.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { EDITABLE_STATUSES } from '@lsi/domain';
import type { AddSignerDto } from './dto/add-signer.dto.js';

@Injectable()
export class SignersService {
  async add(scope: Scope, contractId: string, dto: AddSignerDto) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, tenantId: true, customerId: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({ code: 'RM-04', detail: 'Les signataires ne se modifient que sur un brouillon.' });
      }
      const now = new Date();
      try {
        return await tx.contractSigner.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId,
            party: dto.party, fullName: dto.fullName, email: dto.email,
            signingOrder: dto.signingOrder ?? 0, contactId: dto.contactId ?? null,
            createdAt: now, updatedAt: now,
          },
          select: { id: true, party: true, fullName: true, email: true, signingOrder: true },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') throw new ConflictException('Un signataire avec cet email existe déjà sur ce contrat');
        throw e;
      }
    });
  }

  async remove(scope: Scope, contractId: string, signerId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({ code: 'RM-04', detail: 'Les signataires ne se modifient que sur un brouillon.' });
      }
      const signer = await tx.contractSigner.findFirst({ where: { id: signerId, contractId }, select: { id: true } });
      if (!signer) throw new NotFoundException('Signataire introuvable');
      await tx.contractSigner.delete({ where: { id: signerId } });
    });
  }
}
```

- [ ] **Step 5 : Contrôleur**

```typescript
// apps/api/src/contracts/signers.controller.ts
import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { SignersService } from './signers.service.js';
import { AddSignerDto } from './dto/add-signer.dto.js';

@Controller('v1/contracts')
export class SignersController {
  constructor(private readonly signers: SignersService) {}

  @Post(':id/signers')
  add(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddSignerDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.signers.add(scope, id, dto);
  }

  @Delete(':id/signers/:signerId')
  @HttpCode(204)
  remove(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('signerId', ParseUUIDPipe) signerId: string,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.signers.remove(scope, id, signerId);
  }
}
```

Enregistrer `SignersController` (controllers) + `SignersService` (providers) dans `app.module.ts`.

- [ ] **Step 6 : Lancer, vérifier le succès**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7 : Commit**

```bash
git add apps/api/src/contracts/dto/add-signer.dto.ts apps/api/src/contracts/signers.service.ts apps/api/src/contracts/signers.controller.ts apps/api/src/app.module.ts apps/api/tests/isolation/signers.test.ts
git commit -m "feat(api): POST/DELETE signataires d'un contrat (scopé, éditable)"
```

---

## Task 3 : API — persistance des approbations dans `applyEvent` (RM-10)

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (`applyEvent`)
- Test: `apps/api/tests/isolation/approval-workflow.test.ts`

**Interfaces:**
- Produces: `applyEvent` crée/résout les `contract_approvals` : SUBMIT → PENDING ; APPROVE → APPROVED ; REQUEST_CHANGES → CHANGES_REQUESTED. RM-10 : le soumetteur ne peut approuver (→ 409). `POST :id/submit|approve|request-changes` inchangés côté route.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/approval-workflow.test.ts
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

/** Un contrat A prêt à soumettre : contenu (version) + signataires LSI+client + date. */
async function prepare(): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-WF-${id.slice(-8)}`,
        title: 'WF', type: 'MAIN', status: 'DRAFT', category: 'MAINTENANCE', currency: 'EUR',
        billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, startDate: new Date('2026-08-01'),
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    const v = await tx.contractVersion.create({
      data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id,
        versionNumber: 1, bodyHtml: '<p>Contenu</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId },
      select: { id: true },
    });
    await tx.contract.update({ where: { id }, data: { currentVersionId: v.id } });
    await tx.contractSigner.createMany({
      data: [
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0, createdAt: now, updatedAt: now },
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1, createdAt: now, updatedAt: now },
      ],
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
  // amUserId : ACCOUNT_MANAGER (soumet). adminUserId : MSP_ADMIN (approuve).
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await sessions.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  contractId = await prepare();
});

describe('workflow d’approbation', () => {
  test('soumission → IN_REVIEW + contract_approval PENDING', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/submit`).set('x-lsi-session', 'sess-am').expect(201);
    const approval = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractApproval.findFirst({ where: { contractId }, orderBy: { submittedAt: 'desc' } }));
    expect(approval!.decision).toBe('PENDING');
    expect(approval!.submittedByUserId).toBe(fx.amUserId);
  });

  test('RM-10 : le soumetteur ne peut pas approuver → 409', async () => {
    // sess-am est le soumetteur ; il tente d'approuver.
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/approve`).set('x-lsi-session', 'sess-am').expect(409);
  });

  test('un autre valideur approuve → APPROVED + contract_approval résolu', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/approve`).set('x-lsi-session', 'sess-admin').expect(201);
    const [c, approval] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: contractId }, select: { status: true } }),
      await tx.contractApproval.findFirst({ where: { contractId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    expect(c!.status).toBe('APPROVED');
    expect(approval!.decision).toBe('APPROVED');
    expect(approval!.decidedByUserId).toBe(fx.adminUserId);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/approval-workflow.test.ts`
Expected: FAIL (le 1er test : `approval` est `null`, car `applyEvent` ne crée rien aujourd'hui).

- [ ] **Step 3 : Persister les approbations**

Dans `contracts.service.ts`, méthode `applyEvent`, APRÈS le bloc `try { next = applyEvent(...) } catch (...) { ... }` (qui a validé la transition + RM-10) et AVANT le `return tx.contract.update(...)`, insérer :

```typescript
      // Persistance des approbations (RM-10). Le domaine a déjà tranché : sur
      // APPROVE/REQUEST_CHANGES, il lève si l'acteur est le soumetteur, donc
      // on n'atteint l'update que pour un valideur distinct (le CHECK base
      // `decided_by <> submitted_by` est le filet).
      if (event.type === 'SUBMIT_FOR_REVIEW') {
        await tx.contractApproval.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
            versionId: c.currentVersionId!, // garanti par la règle domaine (RM-11)
            submittedByUserId: event.actorUserId, decision: 'PENDING', submittedAt: now,
          },
        });
      } else if (event.type === 'APPROVE' && approval) {
        await tx.contractApproval.update({
          where: { id: approval.id },
          data: { decision: 'APPROVED', decidedByUserId: event.actorUserId, decidedAt: now },
        });
      } else if (event.type === 'REQUEST_CHANGES' && approval) {
        await tx.contractApproval.update({
          where: { id: approval.id },
          data: { decision: 'CHANGES_REQUESTED', decidedByUserId: event.actorUserId, decidedAt: now, reason: event.reason },
        });
      }
```

(`c`, `approval`, `now`, `id`, `event` sont déjà en portée dans `applyEvent`. Importer `uuidv7` de `@lsi/persistence` si absent. Vérifier que `applyEvent` a bien accès à `now` — sinon utiliser `new Date()`.)

- [ ] **Step 4 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/approval-workflow.test.ts && pnpm exec vitest run tests/isolation/idor.test.ts`
Expected: PASS (workflow 3/3 ; idor inchangé — les transitions y sont testées).

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/contracts/contracts.service.ts apps/api/tests/isolation/approval-workflow.test.ts
git commit -m "feat(api): persistance des contract_approvals (RM-10 réellement appliqué)"
```

---

## Task 4 : API — `allowedActions` charge les signataires + `findOne` enrichi

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (`allowedActions`, `findOne`)
- Test: `apps/api/tests/isolation/allowed-and-detail.test.ts`

**Interfaces:**
- Produces: `allowedActions` reflète les vrais signataires (SUBMIT présent seulement si LSI+client+contenu+date). `findOne` renvoie `signers` (racine : `{ id, party, fullName, email, signingOrder, status }`) et `approval` (`{ submittedByUserId, decision, reason, decidedByUserId } | null`), en plus de l'existant.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/allowed-and-detail.test.ts
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
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  contractId = fx.customerA.contractId; // DRAFT, sans contenu ni signataires au départ
});

describe('allowedActions + findOne', () => {
  test('sans signataires ni contenu : allowed-actions ne contient pas SUBMIT_FOR_REVIEW', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}/allowed-actions`).set('x-lsi-session', 'sess-am').expect(200);
    expect(res.body.allowedActions).not.toContain('SUBMIT_FOR_REVIEW');
  });

  test('avec contenu + signataires + date : SUBMIT_FOR_REVIEW apparaît ; findOne renvoie signers + approval', async () => {
    const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      const v = await tx.contractVersion.create({ data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId }, select: { id: true } });
      await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id, startDate: new Date('2026-08-01') } });
      await tx.contractSigner.createMany({ data: [
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'LSI', fullName: 'M', email: 'm@lsi.fr', signingOrder: 0, createdAt: now, updatedAt: now },
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'CLIENT', fullName: 'J', email: 'j@c.fr', signingOrder: 1, createdAt: now, updatedAt: now },
      ]});
    });
    const allowed = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}/allowed-actions`).set('x-lsi-session', 'sess-am').expect(200);
    expect(allowed.body.allowedActions).toContain('SUBMIT_FOR_REVIEW');

    const detail = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(detail.body.signers).toHaveLength(2);
    expect(detail.body.signers[0]).toHaveProperty('email');
    expect(detail.body).toHaveProperty('approval'); // null tant que non soumis
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/allowed-and-detail.test.ts`
Expected: FAIL (SUBMIT n'apparaît pas car `allowedActions` passe `signers: []` ; `detail.body.signers` est absent).

- [ ] **Step 3 : Corriger `allowedActions`**

Remplacer le corps de `allowedActions` :
```typescript
  async allowedActions(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      // On charge les VRAIS signataires : sinon la garde SUBMIT (LSI+client)
      // ne serait jamais satisfaite et « Soumettre » n'apparaîtrait jamais.
      const c = await tx.contract.findUnique({
        where: { id },
        include: { signers: { select: { party: true } } },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      return allowedEvents(this.toSnapshot({ ...c, attachments: [], amendments: [] }, null));
    });
  }
```

- [ ] **Step 4 : Enrichir `findOne`**

Dans `findOne`, élargir le `select` des signataires et ajouter l'approbation ; retourner les deux :
```typescript
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id },
        orderBy: { signingOrder: 'asc' },
        select: { id: true, party: true, fullName: true, email: true, signingOrder: true, status: true, signedAt: true },
      });
      const approval = await tx.contractApproval.findFirst({
        where: { contractId: id },
        orderBy: { submittedAt: 'desc' },
        select: { submittedByUserId: true, decision: true, reason: true, decidedByUserId: true },
      });
```
et dans le `return`, ajouter `signers` et `approval` au niveau racine, en **conservant** `signatureRequest.signers` (le composant `SignatureBlock` du cockpit le lit — on ne le casse pas ; on réutilise le même tableau `signers`) :
```typescript
      return {
        contract: c,
        customer: c.customer,
        signers,
        approval,
        signatureRequest: sigReq ? { status: sigReq.status, signers } : null,
        reminders,
        timeline,
      };
```

- [ ] **Step 5 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/allowed-and-detail.test.ts tests/isolation/contract-detail.test.ts`
Expected: PASS. Adapter `contract-detail.test.ts` si une assertion lisait `signatureRequest.signers` (déplacée à la racine `signers`).

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts/contracts.service.ts apps/api/tests/isolation/allowed-and-detail.test.ts
git commit -m "feat(api): allowedActions charge les signataires + findOne renvoie signers/approval"
```

---

## Task 5 : API — RM-11 : éditer un contrat approuvé le rouvre

**Files:**
- Modify: `apps/api/src/contracts/content.service.ts` (`saveContent`)
- Test: `apps/api/tests/isolation/edit-reopens-approved.test.ts`

**Interfaces:**
- Produces: `saveContent` accepte un contrat `APPROVED` ; l'enregistrement le repasse en `DRAFT` avec `approvedVersionId = null`. Les statuts non éditables (IN_REVIEW, SIGNED, ACTIVE) restent 409.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/edit-reopens-approved.test.ts
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
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  // Contrat directement en APPROVED avec une version approuvée.
  contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: { id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AP-${contractId.slice(-8)}`, title: 'AP', type: 'MAIN', status: 'APPROVED', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    const v = await tx.contractVersion.create({ data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, versionNumber: 1, bodyHtml: '<p>v1</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId }, select: { id: true } });
    await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id, approvedVersionId: v.id } });
  });
});

describe('RM-11 — édition rouvre un approuvé', () => {
  test('éditer un contrat APPROVED le repasse en DRAFT (approvedVersionId nul)', async () => {
    await request(app.getHttpServer()).put(`/v1/contracts/${contractId}/content`).set('x-lsi-session', 'sess-am').send({ bodyHtml: '<p>v2</p>' }).expect(200);
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: contractId }, select: { status: true, approvedVersionId: true } }));
    expect(c!.status).toBe('DRAFT');
    expect(c!.approvedVersionId).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/edit-reopens-approved.test.ts`
Expected: FAIL (409 : `saveContent` refuse APPROVED aujourd'hui).

- [ ] **Step 3 : Étendre `saveContent`**

Dans `content.service.ts`, `saveContent` : remplacer la garde et l'update finale.
La garde d'éditabilité inclut désormais `APPROVED` :
```typescript
      const EDITABLE_OR_APPROVED = [...EDITABLE_STATUSES, 'APPROVED'] as const;
      if (!EDITABLE_OR_APPROVED.includes(c.status as (typeof EDITABLE_OR_APPROVED)[number])) {
        throw new ConflictException({
          code: 'RM-04',
          detail: 'Le contenu ne peut être édité que sur un brouillon, un contrat renvoyé, ou un contrat approuvé (qui repasse alors en brouillon).',
        });
      }
```
et l'update du contrat applique RM-11 :
```typescript
      await tx.contract.update({
        where: { id },
        data: {
          currentVersionId: version.id,
          // RM-11 : éditer après validation invalide la validation.
          ...(c.status === 'APPROVED' ? { status: 'DRAFT', approvedVersionId: null } : {}),
          updatedAt: now, updatedByUserId: scope.userId,
        },
      });
```

- [ ] **Step 4 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/edit-reopens-approved.test.ts tests/isolation/content-save.test.ts`
Expected: PASS (les deux).

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/contracts/content.service.ts apps/api/tests/isolation/edit-reopens-approved.test.ts
git commit -m "feat(api): éditer un contrat approuvé le rouvre en brouillon (RM-11)"
```

---

## Task 6 : Front — bloc « Signataires » sur la fiche

**Files:**
- Create: `apps/web/src/features/contracts/signers-block.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (intégrer le bloc ; lire `signers`/`approval` de la racine), `apps/web/src/lib/api.ts` (`apiDelete`)
- Test: `apps/web/src/test/signers-block.test.tsx`

**Interfaces:**
- Produces: `<SignersBlock contractId signers editable />` — liste les signataires (nom, partie, email), formulaires inline `[+ LSI]`/`[+ Client]` → `POST …/signers`, suppression → `DELETE …/signers/:id`, invalidation de `['contract', id]` + `['allowed-actions', id]`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/signers-block.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignersBlock } from '../features/contracts/signers-block.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('liste les signataires et ajoute un signataire LSI', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({ id: 's9', party: 'LSI', fullName: 'Marc', email: 'm@lsi.fr', signingOrder: 0 }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignersBlock contractId="k1" editable signers={[{ id: 's1', party: 'CLIENT', fullName: 'Jean', email: 'j@c.fr', signingOrder: 1 }]} />);
  expect(screen.getByText('Jean')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Signataire LSI/ }));
  await userEvent.type(screen.getByLabelText(/Nom/), 'Marc');
  await userEvent.type(screen.getByLabelText(/Email/), 'm@lsi.fr');
  await userEvent.click(screen.getByRole('button', { name: /Ajouter/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/signers-block.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : `apiDelete` + composant**

Ajouter à `apps/web/src/lib/api.ts` :
```typescript
export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try { const b = await res.json(); message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message); } catch { /* */ }
    throw new ApiError(res.status, message);
  }
}
```

```tsx
// apps/web/src/features/contracts/signers-block.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, apiDelete, ApiError } from '../../lib/api.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { partyLabel } from '../../lib/labels.js';

export interface Signer { id: string; party: string; fullName: string; email: string; signingOrder: number; }

function AddForm({ contractId, party, onDone }: { contractId: string; party: 'LSI' | 'CLIENT'; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', email: '' });
  const m = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signers`, { party, fullName: form.fullName.trim(), email: form.email.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] }); onDone(); },
  });
  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.fullName.trim() && form.email.trim();
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <Field label="Nom" htmlFor={`sn-${party}`}><Input id={`sn-${party}`} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
      <Field label="Email" htmlFor={`se-${party}`}><Input id={`se-${party}`} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-3 py-1.5 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">Ajouter</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function SignersBlock({ contractId, signers, editable }: { contractId: string; signers: Signer[]; editable: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'LSI' | 'CLIENT' | null>(null);
  const del = useMutation({
    mutationFn: (signerId: string) => apiDelete(`/v1/contracts/${contractId}/signers/${signerId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] }); },
  });
  return (
    <Card title="Signataires">
      {signers.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun signataire.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {signers.map((s) => (
            <li key={s.id} className="flex items-center justify-between">
              <span>{s.fullName} <span className="text-gray-400">({partyLabel(s.party)})</span> — {s.email}</span>
              {editable && <button type="button" onClick={() => del.mutate(s.id)} className="text-xs text-red-600 hover:underline">Retirer</button>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setAdding('LSI')} className="rounded border px-3 py-1.5 text-sm">+ Signataire LSI</button>
          <button type="button" onClick={() => setAdding('CLIENT')} className="rounded border px-3 py-1.5 text-sm">+ Signataire client</button>
        </div>
      )}
      {editable && adding && <AddForm contractId={contractId} party={adding} onDone={() => setAdding(null)} />}
    </Card>
  );
}
```

- [ ] **Step 4 : Intégrer dans la fiche**

Dans `contract-detail-page.tsx` : mettre à jour l'interface `Detail` pour inclure `signers: Signer[]` (racine) et `approval: { submittedByUserId: string; decision: string; reason: string | null; decidedByUserId: string | null } | null`. Importer et afficher `<SignersBlock contractId={contract.id} signers={q.data.signers} editable={['DRAFT','CHANGES_REQUESTED'].includes(contract.status)} />` (par ex. au-dessus du bloc `SignatureBlock`). NE PAS toucher `SignatureBlock` : `signatureRequest.signers` existe toujours (Task 4 l'a conservé).

- [ ] **Step 5 : Lancer, vérifier le succès**

Run: `pnpm --filter @lsi/web test` puis `pnpm --filter @lsi/web typecheck`
Expected: PASS (toute la suite front) + typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): bloc Signataires (ajout/suppression) sur la fiche"
```

---

## Task 7 : Front — barre d'actions de workflow

**Files:**
- Create: `apps/web/src/features/contracts/workflow-actions.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (intégrer)
- Test: `apps/web/src/test/workflow-actions.test.tsx`

**Interfaces:**
- Produces: `<WorkflowActions contractId status allowedActions roles currentUserId approval />` — affiche les boutons selon `allowedActions` + `roles` + « pas le soumetteur » ; « demander des modifications » et « annuler » ouvrent une saisie de motif ; chaque action POST l'endpoint et invalide `['contract', id]` + `['allowed-actions', id]`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/workflow-actions.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowActions } from '../features/contracts/workflow-actions.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('un valideur (non soumetteur) voit Approuver et peut approuver', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/approve');
    expect(init?.method).toBe('POST');
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<WorkflowActions contractId="k1" status="IN_REVIEW" allowedActions={['APPROVE', 'REQUEST_CHANGES']} roles={['MSP_ADMIN']} currentUserId="reviewer" approval={{ submittedByUserId: 'author', decision: 'PENDING', reason: null, decidedByUserId: null }} />);
  await userEvent.click(screen.getByRole('button', { name: /Approuver/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('le soumetteur ne voit PAS Approuver (RM-10)', () => {
  wrap(<WorkflowActions contractId="k1" status="IN_REVIEW" allowedActions={['APPROVE', 'REQUEST_CHANGES']} roles={['MSP_ADMIN']} currentUserId="author" approval={{ submittedByUserId: 'author', decision: 'PENDING', reason: null, decidedByUserId: null }} />);
  expect(screen.queryByRole('button', { name: /Approuver/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/workflow-actions.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter**

```tsx
// apps/web/src/features/contracts/workflow-actions.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

interface Approval { submittedByUserId: string; decision: string; reason: string | null; decidedByUserId: string | null; }

export function WorkflowActions({
  contractId, allowedActions, roles, currentUserId, approval,
}: {
  contractId: string; status: string; allowedActions: string[]; roles: string[]; currentUserId: string; approval: Approval | null;
}) {
  const qc = useQueryClient();
  const [reasonFor, setReasonFor] = useState<null | 'request-changes' | 'cancel'>(null);
  const [reason, setReason] = useState('');

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => apiPost(`/v1/contracts/${contractId}/${path}`, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setReasonFor(null); setReason('');
    },
  });

  const can = (a: string) => allowedActions.includes(a);
  const isSubmitter = approval?.submittedByUserId === currentUserId;
  const canSubmit = roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  const canReview = roles.some((r) => ['MSP_ADMIN', 'LEGAL_REVIEWER'].includes(r));
  const error = act.error instanceof ApiError ? act.error.message : act.error ? 'Erreur.' : undefined;

  const btn = 'rounded px-4 py-2 text-sm text-white disabled:opacity-50';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {can('SUBMIT_FOR_REVIEW') && canSubmit && (
          <button type="button" disabled={act.isPending} className={`${btn} bg-lsi hover:bg-lsi-dark`} onClick={() => act.mutate({ path: 'submit' })}>Soumettre</button>
        )}
        {can('APPROVE') && canReview && !isSubmitter && (
          <button type="button" disabled={act.isPending} className={`${btn} bg-green-600 hover:bg-green-700`} onClick={() => act.mutate({ path: 'approve' })}>Approuver</button>
        )}
        {can('REQUEST_CHANGES') && canReview && !isSubmitter && (
          <button type="button" className={`${btn} bg-amber-600 hover:bg-amber-700`} onClick={() => setReasonFor('request-changes')}>Demander des modifications</button>
        )}
        {can('CANCEL') && canSubmit && (
          <button type="button" className={`${btn} bg-red-600 hover:bg-red-700`} onClick={() => setReasonFor('cancel')}>Annuler</button>
        )}
      </div>
      {approval && (
        <p className="text-sm text-gray-500">
          Approbation : {approval.decision === 'PENDING' ? 'en attente de revue' : approval.decision === 'APPROVED' ? 'approuvé' : `modifications demandées${approval.reason ? ` — ${approval.reason}` : ''}`}
        </p>
      )}
      {reasonFor && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) act.mutate({ path: reasonFor, body: { reason: reason.trim() } }); }}>
          <textarea className="w-full rounded border p-2 text-sm" placeholder="Motif (obligatoire)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <button type="submit" disabled={!reason.trim() || act.isPending} className={`${btn} bg-lsi hover:bg-lsi-dark`}>Confirmer</button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => { setReasonFor(null); setReason(''); }}>Annuler</button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4 : Intégrer dans la fiche**

Dans `contract-detail-page.tsx` : charger `allowed-actions` (`useQuery(['allowed-actions', id], () => apiGet('/v1/contracts/'+id+'/allowed-actions'))` → `{ allowedActions }`) et `useMe()` (pour `userId`/`roles`), puis afficher `<WorkflowActions contractId={contract.id} status={contract.status} allowedActions={allowed.data?.allowedActions ?? []} roles={me.data?.roles ?? []} currentUserId={me.data?.userId ?? ''} approval={q.data.approval} />` sous l'en-tête.

- [ ] **Step 5 : Lancer, vérifier le succès + suites complètes**

Run: `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis, depuis la racine, `pnpm lint`
Expected: PASS + clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): barre d'actions de workflow (soumettre/approuver/refuser/annuler)"
```

---

## Clôture

- [ ] **Suites** : `cd apps/api && pnpm exec vitest run` ; `cd packages/domain && pnpm exec vitest run` ; `pnpm --filter @lsi/web test` — tout vert.
- [ ] **CI locale** : `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] **Déploiement** : merger sur `main` → CI → redéployer (préserver l'env live, relogin Portainer si besoin). **Aucune migration.** **Provisionner un utilisateur relecteur** (LEGAL_REVIEWER, email fourni) en base prod, puis vérifier le cycle : contenu → signataires → soumettre (AM) → approuver (relecteur), et que le soumetteur ne peut pas approuver.
