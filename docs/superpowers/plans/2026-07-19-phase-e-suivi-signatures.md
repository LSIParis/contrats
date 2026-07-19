# Phase E — Suivi des signatures : relancer / révoquer (§6.8) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter les actions « relancer » et « révoquer » sur une demande de signature en cours, depuis la fiche contrat.

**Architecture:** Nouvelles méthodes provider (`remindSubmitter`/`revokeSubmission`), un événement domaine `REVOKE_SIGNATURE` (PENDING_SIGNATURE/PARTIALLY_SIGNED → APPROVED), deux endpoints scopés, et deux boutons front. L'appel DocuSeal se fait hors transaction (EC-04) ; l'effet local n'est persisté qu'après succès.

**Tech Stack:** NestJS 10, Prisma 5, domaine TS pur, React 18, TanStack Query 5, Vitest + Testing Library + supertest + Testcontainers ; DocuSeal (fake en test).

## Global Constraints

- **Monorepo pnpm** ; front = `@lsi/web`. Node 22, pnpm 9.15.9. Runtime API en **SWC**.
- **Sécurité** : endpoints scopés par le `ScopeGuard` global. **404 (jamais 403) hors scope** ; **403** rôle insuffisant (`assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`) ; **409** pas de demande active / transition invalide ; **502** provider indisponible (rien ne bouge, EC-04). Data via `withScope`. Le front ne porte AUCUNE autorisation.
- **UI en français.** CI (`lint`+`typecheck`+`test`) verte. Interdit `$queryRawUnsafe`/`$executeRawUnsafe` hors testing.
- **Pattern de test API** : `SessionService.put(...)` + en-tête `x-lsi-session`. Provider en test : `FakeProvider` (de `apps/api/tests/support/fakes.js`), fourni via `.overrideProvider(ESIGNATURE_PROVIDER).useValue(provider)`.
- **Aucune migration.**

---

## Structure de fichiers

**Domaine**
- Modify: `packages/domain/src/contract/contract.types.ts` (ContractEvent), `packages/domain/src/contract/state-machine.ts` (TRANSITIONS + case + allowedEvents)
- Modify: `packages/domain/src/signature/e-signature-provider.port.ts` (port)
- Test: `packages/domain/tests/revoke-signature.test.ts`

**API**
- Modify: `apps/api/src/signature/docuseal.adapter.ts` (remind/revoke)
- Modify: `apps/api/tests/support/fakes.ts` (FakeProvider)
- Create: `apps/api/src/signature/signature-actions.service.ts`, `apps/api/src/signature/signature-actions.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/signature-actions.test.ts`

**Front (`apps/web`)**
- Create: `apps/web/src/features/contracts/signature-actions.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`

---

## Task 1 : Domaine + port — `REVOKE_SIGNATURE` et méthodes provider

**Files:**
- Modify: `packages/domain/src/contract/contract.types.ts`, `packages/domain/src/contract/state-machine.ts`
- Modify: `packages/domain/src/signature/e-signature-provider.port.ts`
- Test: `packages/domain/tests/revoke-signature.test.ts`

**Interfaces:**
- Produces: événement `{ type: 'REVOKE_SIGNATURE'; actorUserId: string }` ; `applyEvent(..., REVOKE_SIGNATURE)` : PENDING_SIGNATURE/PARTIALLY_SIGNED → APPROVED ; `allowedEvents` l'inclut dans ces statuts. Port `ESignatureProvider` : `remindSubmitter(id): Promise<void>`, `revokeSubmission(id): Promise<void>`.

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// packages/domain/tests/revoke-signature.test.ts
import { describe, test, expect } from 'vitest';
import { applyEvent, allowedEvents, type ContractSnapshot } from '../src/index.js';

function pending(status: 'PENDING_SIGNATURE' | 'PARTIALLY_SIGNED'): ContractSnapshot {
  return {
    id: 'c1', type: 'MAIN', status,
    startDate: new Date('2026-07-01'), endDate: null, noticePeriodDays: null,
    currentVersionId: 'v1', approvedVersionId: 'v1', submittedByUserId: null,
    hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
    openAmendmentExists: false, hasSignedSuccessor: false,
    signedAt: null, activatedAt: null, terminatedAt: null,
  };
}

describe('REVOKE_SIGNATURE', () => {
  test('depuis PENDING_SIGNATURE → APPROVED (approvedVersionId conservé)', () => {
    const next = applyEvent(pending('PENDING_SIGNATURE'), { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date());
    expect(next.status).toBe('APPROVED');
    expect(next.approvedVersionId).toBe('v1');
  });

  test('depuis PARTIALLY_SIGNED → APPROVED', () => {
    expect(applyEvent(pending('PARTIALLY_SIGNED'), { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date()).status).toBe('APPROVED');
  });

  test('allowedEvents inclut REVOKE_SIGNATURE en PENDING_SIGNATURE', () => {
    expect(allowedEvents(pending('PENDING_SIGNATURE'))).toContain('REVOKE_SIGNATURE');
  });

  test('depuis APPROVED, REVOKE_SIGNATURE est une transition invalide', () => {
    const approved = { ...pending('PENDING_SIGNATURE'), status: 'APPROVED' as const };
    expect(() => applyEvent(approved, { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date())).toThrow();
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd packages/domain && pnpm exec vitest run tests/revoke-signature.test.ts`
Expected: FAIL (`REVOKE_SIGNATURE` inconnu).

- [ ] **Step 3 : Implémenter dans le domaine**

Dans `contract.types.ts`, `ContractEvent` — ajouter la variante (par ex. après `SEND_FOR_SIGNATURE`) :
```typescript
  | { type: 'REVOKE_SIGNATURE'; actorUserId: string }
```
Dans `state-machine.ts` :
- `TRANSITIONS` : ajouter `'REVOKE_SIGNATURE'` aux deux entrées :
```typescript
  PENDING_SIGNATURE: ['SIGNER_SIGNED', 'SIGNER_DECLINED', 'REVOKE_SIGNATURE', 'CANCEL'],
  PARTIALLY_SIGNED: ['SIGNER_SIGNED', 'SIGNER_DECLINED', 'REVOKE_SIGNATURE', 'CANCEL'],
```
- Ajouter le cas dans `applyEvent` (par ex. près de `SEND_FOR_SIGNATURE`) :
```typescript
    case 'REVOKE_SIGNATURE': {
      // Révoquer DÉFAIT l'envoi : le contrat redevient approuvé (envoyable),
      // sa validation reste valable. Ce n'est PAS annuler le contrat (§6.13).
      return { ...c, status: 'APPROVED' };
    }
```
- `allowedEvents` : aucun filtre spécial pour `REVOKE_SIGNATURE` → le `default: return true` s'applique (ne rien ajouter).

Dans `e-signature-provider.port.ts`, interface `ESignatureProvider` — ajouter :
```typescript
  /** Relance : renvoie l'email d'invitation à un signataire (PUT /submitters/{id}). */
  remindSubmitter(providerSubmitterId: string): Promise<void>;

  /** Révocation : archive la submission chez le provider (DELETE /submissions/{id}). */
  revokeSubmission(providerSubmissionId: string): Promise<void>;
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `cd packages/domain && pnpm exec vitest run tests/revoke-signature.test.ts && pnpm exec vitest run`
Expected: PASS (nouveau fichier + suite domaine). Note : ajouter les deux méthodes au port va casser la compilation du `DocusealAdapter` et du `FakeProvider` (ne les implémentent pas encore) — c'est attendu, corrigé en Task 2. Le `pnpm exec vitest run` du domaine ne compile QUE `packages/domain` (le port n'a pas d'implémentation ici), donc il passe.

- [ ] **Step 5 : Commit**

```bash
git add packages/domain/src apps/api packages/domain/tests/revoke-signature.test.ts 2>/dev/null; git add packages/domain
git commit -m "feat(domain): REVOKE_SIGNATURE (PENDING_SIGNATURE → APPROVED) + port remind/revoke"
```

---

## Task 2 : API — relance (`POST …/signature/remind`) + adaptateur + fake

**Files:**
- Modify: `apps/api/src/signature/docuseal.adapter.ts` (implémenter `remindSubmitter` + `revokeSubmission`)
- Modify: `apps/api/tests/support/fakes.ts` (FakeProvider : les deux méthodes)
- Create: `apps/api/src/signature/signature-actions.service.ts`, `apps/api/src/signature/signature-actions.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/signature-actions.test.ts`

**Interfaces:**
- Produces: `POST /v1/contracts/:id/signature/remind` → `{ reminded: number }`. Scopé, 403 rôle, 404 hors scope, 409 sans demande active. Le `DocusealAdapter` et le `FakeProvider` implémentent désormais `remindSubmitter` + `revokeSubmission` (le second sera consommé en Task 3).

- [ ] **Step 1 : Écrire le test qui échoue**

```typescript
// apps/api/tests/isolation/signature-actions.test.ts
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { FakeProvider } from '../support/fakes.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let provider: FakeProvider;

/**
 * Un contrat en PENDING_SIGNATURE avec une demande active + 2 signataires
 * envoyés. `providerSubmissionId` et `providerSubmitterId` portent des UNIQUE
 * GLOBAUX (`@@unique([provider, providerSubmissionId])`,
 * `@@unique([providerSubmitterId])`) : on les dérive de l'`id` du contrat pour
 * qu'appeler `seedInProgress` plusieurs fois dans le même fichier ne
 * collisionne pas. `customerId` par défaut = customerA (IDOR : passer customerB).
 */
async function seedInProgress(customer: { id: string } = fx.customerA) {
  const id = uuidv7();
  const vId = uuidv7();
  const reqId = uuidv7();
  const sfx = id.slice(-12);
  const submissionId = `SUB-${sfx}`;
  const submitterIds = [`SUBM-${sfx}-0`, `SUBM-${sfx}-1`];
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: customer.id, reference: `LSI-SIG-${sfx}`,
      title: 'S', type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE', currency: 'EUR',
      billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, currentVersionId: vId, approvedVersionId: vId,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId: customer.id, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
    await tx.signatureRequest.create({ data: {
      id: reqId, tenantId: fx.tenantId, customerId: customer.id, contractId: id, versionId: vId,
      provider: 'DOCUSEAL', providerSubmissionId: submissionId, status: 'SENT', idempotencyKey: uuidv7(),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId } });
    await tx.contractSigner.createMany({ data: [
      { id: uuidv7(), tenantId: fx.tenantId, customerId: customer.id, contractId: id, party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0, status: 'SENT', providerSubmitterId: submitterIds[0], createdAt: now, updatedAt: now },
      { id: uuidv7(), tenantId: fx.tenantId, customerId: customer.id, contractId: id, party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1, status: 'SENT', providerSubmitterId: submitterIds[1], createdAt: now, updatedAt: now },
    ]});
  });
  return { id, reqId, submissionId, submitterIds };
}

beforeAll(async () => {
  provider = new FakeProvider();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ESIGNATURE_PROVIDER).useValue(provider).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await sessions.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
});

beforeEach(() => provider.reset());

describe('POST /v1/contracts/:id/signature/remind', () => {
  test('relance les signataires en cours via le provider', async () => {
    const { id, submitterIds } = await seedInProgress();
    const res = await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/remind`).set('x-lsi-session', 'sess-am').expect(201);
    expect(res.body.reminded).toBe(2);
    expect([...provider.reminded].sort()).toEqual([...submitterIds].sort());
  });

  test('sans demande active → 409', async () => {
    // Le contrat A initial (fx.customerA.contractId) est DRAFT, sans demande.
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signature/remind`).set('x-lsi-session', 'sess-am').expect(409);
  });

  test('IDOR : contrat de B → 404', async () => {
    const { id } = await seedInProgress();
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/remind`).set('x-lsi-session', 'sess-am-b').expect(404);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signature-actions.test.ts`
Expected: FAIL (route absente ; et `FakeProvider.reminded` / méthodes inexistantes → erreur de compilation à corriger).

- [ ] **Step 3 : Adaptateur + fake**

Dans `docuseal.adapter.ts`, ajouter (mêmes `baseUrl`/`apiKey`/style d'erreur que `createSubmission`) :
```typescript
  async remindSubmitter(providerSubmitterId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/submitters/${providerSubmitterId}`, {
      method: 'PUT',
      headers: { 'X-Auth-Token': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ send_email: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderError(`relance échouée (${res.status})`, res.status >= 500);
  }

  async revokeSubmission(providerSubmissionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/submissions/${providerSubmissionId}`, {
      method: 'DELETE',
      headers: { 'X-Auth-Token': this.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderError(`révocation échouée (${res.status})`, res.status >= 500);
  }
```
(Vérifier que `ProviderError` est déjà importé dans l'adaptateur ; sinon l'importer depuis `@lsi/domain`.)

Dans `fakes.ts`, `FakeProvider` — ajouter les champs et méthodes (respecter `failNext`) :
```typescript
  readonly reminded: string[] = [];
  readonly revoked: string[] = [];
  // … dans reset() : this.reminded.length = 0; this.revoked.length = 0;

  async remindSubmitter(providerSubmitterId: string): Promise<void> {
    if (this.failure) { const m = this.failure; this.failure = null; throw new ProviderError(m, true); }
    this.reminded.push(providerSubmitterId);
  }
  async revokeSubmission(providerSubmissionId: string): Promise<void> {
    if (this.failure) { const m = this.failure; this.failure = null; throw new ProviderError(m, true); }
    this.revoked.push(providerSubmissionId);
  }
```

- [ ] **Step 4 : Service + contrôleur**

```typescript
// apps/api/src/signature/signature-actions.service.ts
import { ConflictException, Inject, Injectable, NotFoundException, BadGatewayException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { ProviderError, type ESignatureProvider } from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';

const ACTIVE = ['SENT', 'PARTIALLY_COMPLETED'] as const;

@Injectable()
export class SignatureActionsService {
  constructor(@Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider) {}

  async remind(scope: Scope, contractId: string): Promise<{ reminded: number }> {
    const submitters = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const req = await tx.signatureRequest.findFirst({
        where: { contractId, status: { in: ACTIVE as unknown as string[] } },
        orderBy: { createdAt: 'desc' }, select: { id: true },
      });
      if (!req) throw new ConflictException({ code: 'NO_ACTIVE_REQUEST', detail: 'Aucune demande de signature en cours.' });
      const signers = await tx.contractSigner.findMany({
        where: { contractId, status: { in: ['SENT', 'VIEWED'] }, providerSubmitterId: { not: null } },
        select: { providerSubmitterId: true },
      });
      return signers.map((s) => s.providerSubmitterId!) as string[];
    });

    try {
      for (const id of submitters) await this.provider.remindSubmitter(id);
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : (e as Error).message;
      throw new BadGatewayException({ code: 'SIGNATURE_PROVIDER_ERROR', detail: `Relance impossible : ${msg}`, retryable: true });
    }
    return { reminded: submitters.length };
  }
}
```

```typescript
// apps/api/src/signature/signature-actions.controller.ts
import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { SignatureActionsService } from './signature-actions.service.js';

@Controller('v1/contracts')
export class SignatureActionsController {
  constructor(private readonly actions: SignatureActionsService) {}

  @Post(':id/signature/remind')
  remind(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.actions.remind(scope, id);
  }
}
```

Enregistrer `SignatureActionsController` (controllers) + `SignatureActionsService` (providers) dans `app.module.ts`.

- [ ] **Step 5 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signature-actions.test.ts && pnpm exec vitest run tests/isolation/send-for-signature.test.ts`
Expected: PASS (les nouvelles routes + l'envoi existant, qui utilise le même FakeProvider — vérifier que l'ajout des méthodes ne casse rien). `pnpm --filter @lsi/api exec tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/signature apps/api/tests/support/fakes.ts apps/api/src/app.module.ts apps/api/tests/isolation/signature-actions.test.ts
git commit -m "feat(api): POST signature/remind + méthodes provider remind/revoke"
```

---

## Task 3 : API — révocation (`POST …/signature/revoke`)

**Files:**
- Modify: `apps/api/src/signature/signature-actions.service.ts`, `apps/api/src/signature/signature-actions.controller.ts`
- Test: `apps/api/tests/isolation/signature-actions.test.ts` (ajouts)

**Interfaces:**
- Produces: `POST /v1/contracts/:id/signature/revoke` → `{ status: 'REVOKED' }`. Révoque chez le provider (I/O), puis : `signature_request` → REVOKED, signataires → PENDING (+ `providerSubmitterId`/slug null), contrat → APPROVED (domaine `REVOKE_SIGNATURE`). 404 hors scope, 409 sans demande active, 502 échec provider (rien ne bouge).

- [ ] **Step 1 : Ajouter les tests (RED)**

Dans `signature-actions.test.ts`, ajouter :

```typescript
describe('POST /v1/contracts/:id/signature/revoke', () => {
  test('révoque : provider archivé, demande REVOKED, contrat APPROVED, signataires PENDING', async () => {
    const { id, submissionId } = await seedInProgress();
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(201);
    expect(provider.revoked).toContain(submissionId);
    const [c, req, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { status: true } }),
      await tx.signatureRequest.findFirst({ where: { contractId: id }, orderBy: { createdAt: 'desc' }, select: { status: true } }),
      await tx.contractSigner.findMany({ where: { contractId: id }, select: { status: true, providerSubmitterId: true } }),
    ]);
    expect(c!.status).toBe('APPROVED');
    expect(req!.status).toBe('REVOKED');
    expect(signers.every((s) => s.status === 'PENDING' && s.providerSubmitterId === null)).toBe(true);
  });

  test('échec provider → 502, rien ne bouge', async () => {
    const { id } = await seedInProgress();
    provider.failNext('DocuSeal indisponible');
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(502);
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id }, select: { status: true } }));
    expect(c!.status).toBe('PENDING_SIGNATURE'); // inchangé
  });

  test('sans demande active → 409', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(409);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signature-actions.test.ts`
Expected: FAIL (route `revoke` absente → 404).

- [ ] **Step 3 : Méthode service + route**

Dans `signature-actions.service.ts`, importer `applyEvent` de `@lsi/domain` et ajouter :
```typescript
  async revoke(scope: Scope, contractId: string): Promise<{ status: 'REVOKED' }> {
    // tx1 : valider + récupérer la submission à archiver
    const req = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true, status: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const sr = await tx.signatureRequest.findFirst({
        where: { contractId, status: { in: ACTIVE as unknown as string[] } },
        orderBy: { createdAt: 'desc' }, select: { id: true, providerSubmissionId: true },
      });
      if (!sr) throw new ConflictException({ code: 'NO_ACTIVE_REQUEST', detail: 'Aucune demande de signature en cours.' });
      // Le domaine valide la transition (PENDING_SIGNATURE/PARTIALLY_SIGNED requis).
      this.assertCanRevoke(c.status);
      return sr;
    });

    // I/O hors transaction (EC-04) : on n'acte la révocation qu'après le provider.
    if (req.providerSubmissionId) {
      try {
        await this.provider.revokeSubmission(req.providerSubmissionId);
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : (e as Error).message;
        throw new BadGatewayException({ code: 'SIGNATURE_PROVIDER_ERROR', detail: `Révocation impossible : ${msg}`, retryable: true });
      }
    }

    // tx2 : acter localement
    await withScope(scope, async (tx) => {
      const now = new Date();
      await tx.signatureRequest.update({ where: { id: req.id }, data: { status: 'REVOKED', updatedAt: now } });
      await tx.contractSigner.updateMany({
        where: { contractId },
        data: { status: 'PENDING', providerSubmitterId: null, providerSubmitterSlug: null, updatedAt: now },
      });
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { status: true } });
      const next = applyEvent(this.snapshot(c!.status), { type: 'REVOKE_SIGNATURE', actorUserId: scope.userId }, now);
      await tx.contract.update({ where: { id: contractId }, data: { status: next.status, updatedAt: now, updatedByUserId: scope.userId } });
    });
    return { status: 'REVOKED' };
  }

  private assertCanRevoke(status: string): void {
    try {
      applyEvent(this.snapshot(status), { type: 'REVOKE_SIGNATURE', actorUserId: 'check' }, new Date());
    } catch (e) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', detail: (e as Error).message, currentStatus: status });
    }
  }

  /** Snapshot minimal : REVOKE_SIGNATURE ne lit que le statut. */
  private snapshot(status: string): any {
    return {
      id: 'x', type: 'MAIN', status, startDate: null, endDate: null, noticePeriodDays: null,
      currentVersionId: null, approvedVersionId: null, submittedByUserId: null,
      hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
      openAmendmentExists: false, hasSignedSuccessor: false,
      signedAt: null, activatedAt: null, terminatedAt: null,
    };
  }
```
(Vérifier le nom exact du champ slug sur `ContractSigner` — `providerSubmitterSlug` — dans le schéma ; l'ajuster si différent.)

Dans `signature-actions.controller.ts`, ajouter :
```typescript
  @Post(':id/signature/revoke')
  revoke(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.actions.revoke(scope, id);
  }
```

- [ ] **Step 4 : Lancer, vérifier le succès + suite complète**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/signature-actions.test.ts && pnpm exec vitest run`
Expected: PASS (remind + revoke ; suite complète verte).

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/signature apps/api/tests/isolation/signature-actions.test.ts
git commit -m "feat(api): POST signature/revoke (provider archive + contrat → APPROVED, EC-04)"
```

---

## Task 4 : Front — boutons Relancer / Révoquer

**Files:**
- Create: `apps/web/src/features/contracts/signature-actions.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/signature-actions.test.tsx`

**Interfaces:**
- Produces: `<SignatureActions contractId status roles />` — quand `status ∈ {PENDING_SIGNATURE, PARTIALLY_SIGNED}` et rôle MSP_ADMIN/ACCOUNT_MANAGER : `[Relancer]` → POST remind ; `[Révoquer]` (confirmation) → POST revoke ; invalide `['contract', id]` + `['allowed-actions', id]`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/signature-actions.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignatureActions } from '../features/contracts/signature-actions.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('relance : POST vers /signature/remind', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/signature/remind');
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({ reminded: 2 }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignatureActions contractId="k1" status="PENDING_SIGNATURE" roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Relancer/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('révoquer demande confirmation puis POST /signature/revoke', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/signature/revoke');
    return new Response(JSON.stringify({ status: 'REVOKED' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignatureActions contractId="k1" status="PENDING_SIGNATURE" roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Révoquer/ }));
  await userEvent.click(screen.getByRole('button', { name: /Confirmer la révocation/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('hors PENDING_SIGNATURE, aucun bouton', () => {
  wrap(<SignatureActions contractId="k1" status="APPROVED" roles={['MSP_ADMIN']} />);
  expect(screen.queryByRole('button', { name: /Relancer/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/signature-actions.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : Implémenter**

```tsx
// apps/web/src/features/contracts/signature-actions.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

const IN_PROGRESS = ['PENDING_SIGNATURE', 'PARTIALLY_SIGNED'];

export function SignatureActions({ contractId, status, roles }: { contractId: string; status: string; roles: string[] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const canAct = IN_PROGRESS.includes(status) && roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));

  const remind = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signature/remind`, {}),
  });
  const revoke = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signature/revoke`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setConfirming(false);
    },
  });

  if (!canAct) return null;
  const err = (m: typeof remind | typeof revoke) => (m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={remind.isPending} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => remind.mutate()}>
          {remind.isPending ? 'Relance…' : 'Relancer'}
        </button>
        <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setConfirming(true)}>Révoquer</button>
      </div>
      {remind.isSuccess && <p className="text-sm text-green-700">Relance envoyée.</p>}
      {err(remind) && <p className="text-sm text-red-600">{err(remind)}</p>}
      {confirming && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">La demande de signature sera annulée ; le contrat redeviendra approuvé (vous pourrez le renvoyer).</p>
          <div className="flex gap-2">
            <button type="button" disabled={revoke.isPending} className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50" onClick={() => revoke.mutate()}>
              {revoke.isPending ? 'Révocation…' : 'Confirmer la révocation'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setConfirming(false)}>Annuler</button>
          </div>
          {err(revoke) && <p className="text-sm text-red-600">{err(revoke)}</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : Intégrer dans la fiche**

Dans `contract-detail-page.tsx` : `<SignatureActions contractId={contract.id} status={contract.status} roles={me.data?.roles ?? []} />`, près du bloc `SignatureBlock` (`me` déjà chargé dans la fiche).

- [ ] **Step 5 : Lancer, vérifier le succès + suites**

Run: `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis, depuis la racine, `pnpm lint`
Expected: PASS + clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): actions Relancer / Révoquer sur la fiche contrat"
```

---

## Clôture

- [ ] **Suites** : `cd packages/domain && pnpm exec vitest run` ; `cd apps/api && pnpm exec vitest run` ; `pnpm --filter @lsi/web test` — vert.
- [ ] **CI locale** : `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] **Déploiement** : merger sur `main` → CI → redéployer (préserver l'env live, relogin Portainer si besoin). **Aucune migration.** ⚠️ DocuSeal réel : révoquer archive une vraie submission ; relancer renvoie un email — valider prudemment sur une submission de test.
