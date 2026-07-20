# Phase E — Renouvellements (§6.12) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Initier un renouvellement (successeur pré-rempli + `RenewalRequest`), le refuser, l'accepter automatiquement à la signature du successeur, avec l'UI.

**Architecture:** Domaine `assertCanRenew` (garde pure). API `renew`/`renew/refuse` + hook ACCEPTED au webhook. `findOne` expose les liens. Front bouton Renouveler + bandeaux + Refuser. Le passage du parent à RENEWED reste géré par le sweep de cycle de vie existant.

**Tech Stack:** NestJS 10, Prisma 5, domaine TS pur, React 18, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité** : scopé (`withScope`) ; **404 (jamais 403) hors scope** ; **403** rôle (`assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`) ; **409** garde/état. Le front ne porte AUCUNE autorisation.
- Enums existants : `RenewalStatus` {PENDING, ACCEPTED, REFUSED, EXPIRED}. `Contract.predecessorContractId`/`successorContractId`, table `RenewalRequest` (`contractId`=parent, `newContractId`=successeur). **Aucune migration.**
- Le parent → RENEWED est géré ailleurs (lifecycle sweep, `!!successor.signedAt`) — **ne rien changer** à ça.
- Pattern de test API : `SessionService.put` + `x-lsi-session` ; `seedTwoCustomers` (`fx.tenantId, fx.amUserId, fx.amBUserId, fx.adminUserId, fx.customerA.id, fx.customerB.id`) ; `adminScope`/`internalScope`/`withScope`/`uuidv7`.

---

## Structure de fichiers

- Modify: `packages/domain/src/contract/state-machine.ts` (`assertCanRenew`) ; Test: `packages/domain/tests/renew-guard.test.ts`
- Create: `apps/api/src/contracts/dto/refuse-renewal.dto.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts` (`renew`, `refuseRenewal`, `findOne` augmenté), `apps/api/src/contracts/contracts.controller.ts`
- Modify: `apps/api/src/webhooks/docuseal-webhook.service.ts` (hook ACCEPTED)
- Test: `apps/api/tests/isolation/renew-contract.test.ts`
- Create: `apps/web/src/features/contracts/renew-contract.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/renew-contract.test.tsx`

---

## Task 1 : Domaine `assertCanRenew` + API `renew` + `findOne` augmenté

**Files:** domaine + `contracts.service.ts` + `contracts.controller.ts` + tests.

**Interfaces:**
- Produces: `assertCanRenew(parent)` (domaine) ; `POST /v1/contracts/:id/renew` → `{ id, reference }` (crée successeur DRAFT + `RenewalRequest` PENDING + liens) ; `findOne` renvoie en plus `renewal` et `predecessor`.

- [ ] **Step 1 : domaine — test qui échoue**

```typescript
// packages/domain/tests/renew-guard.test.ts
import { describe, test, expect } from 'vitest';
import { assertCanRenew, BusinessRuleError, type ContractSnapshot } from '../src/index.js';

const snap = (status: string): ContractSnapshot => ({
  id: 'c', type: 'MAIN', status: status as any, startDate: null, endDate: null, noticePeriodDays: null,
  currentVersionId: 'v', approvedVersionId: 'v', submittedByUserId: null,
  hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
  openAmendmentExists: false, hasSignedSuccessor: false, signedAt: null, activatedAt: null, terminatedAt: null,
});

describe('assertCanRenew', () => {
  test('ACTIVE et EXPIRED sont renouvelables', () => {
    expect(() => assertCanRenew(snap('ACTIVE'))).not.toThrow();
    expect(() => assertCanRenew(snap('EXPIRED'))).not.toThrow();
  });
  test('DRAFT/SIGNED → BusinessRuleError RM-16', () => {
    expect(() => assertCanRenew(snap('DRAFT'))).toThrow(BusinessRuleError);
    expect(() => assertCanRenew(snap('SIGNED'))).toThrow(BusinessRuleError);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec** — `cd packages/domain && pnpm exec vitest run tests/renew-guard.test.ts` (FAIL : `assertCanRenew` absent).

- [ ] **Step 3 : implémenter le garde domaine**

Dans `state-machine.ts`, près de `assertCanAmend` :
```typescript
/** RM-16 : un renouvellement ne porte que sur un contrat actif ou expiré. */
export function assertCanRenew(parent: ContractSnapshot): void {
  if (parent.status !== 'ACTIVE' && parent.status !== 'EXPIRED') {
    throw new BusinessRuleError(
      `Un renouvellement ne peut porter que sur un contrat actif ou expiré (statut actuel : ${parent.status}).`,
      'RM-16',
    );
  }
}
```
(Exporté via `packages/domain/src/index.ts` — `export * from './contract/state-machine.js'` le couvre déjà.)

- [ ] **Step 4 : API — test qui échoue**

```typescript
// apps/api/tests/isolation/renew-contract.test.ts
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

async function seedActive(over: Record<string, unknown> = {}, cid?: string) {
  const id = uuidv7(); const vId = uuidv7(); const now = new Date();
  const customerId = cid ?? fx.customerA.id;
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId, reference: `LSI-REN-${id.slice(-8)}`,
      title: 'Maintenance', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(120000), ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId, ...over } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}
const renew = (id: string, sess = 'sess-am') => request(app.getHttpServer()).post(`/v1/contracts/${id}/renew`).set('x-lsi-session', sess);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'sess-viewer', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
});

describe('POST /v1/contracts/:id/renew', () => {
  test('crée un successeur DRAFT pré-rempli + RenewalRequest PENDING + liens', async () => {
    const id = await seedActive();
    const res = await renew(id).expect(201);
    const newId = res.body.id;
    expect(newId).toBeTruthy();
    const [parent, succ, rr] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { successorContractId: true } }),
      await tx.contract.findUnique({ where: { id: newId }, select: { type: true, status: true, predecessorContractId: true, title: true, noticePeriodDays: true, startDate: true, endDate: true } }),
      await tx.renewalRequest.findFirst({ where: { contractId: id } }),
    ]);
    expect(parent!.successorContractId).toBe(newId);
    expect(succ).toMatchObject({ type: 'MAIN', status: 'DRAFT', predecessorContractId: id, noticePeriodDays: 30 });
    expect(succ!.title).toContain('renouvellement');
    // début = fin du parent (2026-12-31) + 1 j = 2027-01-01
    expect(succ!.startDate?.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(rr).toMatchObject({ status: 'PENDING', newContractId: newId, initiatedByUserId: fx.amUserId });
  });

  test('renouveler un DRAFT → 409 (RM-16)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    const res = await renew(id); expect(res.status).toBe(409); expect(res.body.rule).toBe('RM-16');
  });

  test('double renouvellement → 409', async () => {
    const id = await seedActive();
    await renew(id).expect(201);
    await renew(id).expect(409);
  });

  test('rôle insuffisant → 403', async () => {
    const id = await seedActive();
    await renew(id, 'sess-viewer').expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await renew(id, 'sess-am-b').expect(404);
  });

  test('findOne expose renewal (parent) et predecessor (successeur)', async () => {
    const id = await seedActive();
    const newId = (await renew(id).expect(201)).body.id;
    const parentView = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(parentView.body.renewal).toMatchObject({ status: 'PENDING', newContractId: newId });
    const succView = await request(app.getHttpServer()).get(`/v1/contracts/${newId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(succView.body.predecessor?.id).toBe(id);
  });
});
```

- [ ] **Step 5 : lancer, vérifier l'échec** — `cd apps/api && pnpm exec vitest run tests/isolation/renew-contract.test.ts` (FAIL : route absente).

- [ ] **Step 6 : implémenter service + contrôleur + findOne**

Dans `contracts.service.ts`, importer `assertCanRenew`, `BusinessRuleError`, le type `Session`. Ajouter :
```typescript
  async renew(scope: Scope, id: string, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const parent = await tx.contract.findUnique({ where: { id }, include: { signers: { select: { party: true } }, attachments: { select: { id: true } }, amendments: { select: { status: true } } } });
      if (!parent) throw new NotFoundException('Contrat introuvable');
      try {
        assertCanRenew(this.toSnapshot(parent, null));
      } catch (e) {
        if (e instanceof BusinessRuleError) throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        throw e;
      }
      const existing = await tx.renewalRequest.findFirst({ where: { contractId: id, status: 'PENDING' } });
      if (existing) throw new ConflictException({ code: 'RENEWAL_ALREADY_IN_PROGRESS', detail: 'Un renouvellement est déjà en cours pour ce contrat.' });

      const start = parent.endDate ? new Date(parent.endDate.getTime() + 86400000) : now;
      const end = parent.startDate && parent.endDate
        ? new Date(start.getTime() + (parent.endDate.getTime() - parent.startDate.getTime()))
        : null;

      const newId = uuidv7();
      const successor = await tx.contract.create({ data: {
        id: newId, tenantId: parent.tenantId, customerId: parent.customerId,
        reference: await this.nextReference(tx, parent.tenantId, now),
        title: `${parent.title} (renouvellement)`, type: 'MAIN', status: 'DRAFT',
        category: parent.category, currency: parent.currency, billingFrequency: parent.billingFrequency,
        amountCents: parent.amountCents, noticePeriodDays: parent.noticePeriodDays,
        predecessorContractId: parent.id, startDate: start, endDate: end,
        ownerUserId: session.userId, createdAt: now, updatedAt: now, createdByUserId: session.userId, updatedByUserId: session.userId,
      }});
      await tx.contract.update({ where: { id }, data: { successorContractId: newId, updatedAt: now } });
      await tx.renewalRequest.create({ data: {
        id: uuidv7(), tenantId: parent.tenantId, customerId: parent.customerId, contractId: id,
        newContractId: newId, status: 'PENDING', initiatedByUserId: session.userId, initiatedAt: now,
      }});
      return { id: newId, reference: successor.reference };
    });
  }
```

Dans `findOne`, avant le `return`, charger et exposer les liens :
```typescript
      const renewalRow = await tx.renewalRequest.findFirst({ where: { contractId: id }, orderBy: { initiatedAt: 'desc' } });
      let renewal = null;
      if (renewalRow) {
        const succ = renewalRow.newContractId ? await tx.contract.findUnique({ where: { id: renewalRow.newContractId }, select: { reference: true, status: true } }) : null;
        renewal = { status: renewalRow.status, newContractId: renewalRow.newContractId, refusalReason: renewalRow.refusalReason, successor: succ };
      }
      const predecessor = c.predecessorContractId
        ? await tx.contract.findUnique({ where: { id: c.predecessorContractId }, select: { id: true, reference: true } })
        : null;
```
et ajouter `renewal,` et `predecessor,` au littéral retourné. (Le `findUnique` de `findOne` doit sélectionner/inclure `predecessorContractId` — il charge déjà le contrat entier `c`, donc le champ est présent.)

Dans `contracts.controller.ts`, ajouter :
```typescript
  @Post(':id/renew')
  async renew(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.renew(scope, id, session, new Date());
  }
```

- [ ] **Step 7 : lancer, vérifier le succès + suite** — `cd apps/api && pnpm exec vitest run tests/isolation/renew-contract.test.ts && pnpm exec vitest run` ; typecheck clean ; domaine `cd packages/domain && pnpm exec vitest run`.

- [ ] **Step 8 : Commit**

```bash
git add packages/domain apps/api/src/contracts apps/api/tests/isolation/renew-contract.test.ts packages/domain/tests/renew-guard.test.ts
git commit -m "feat(renouvellements): assertCanRenew + POST renew (successeur pré-rempli + RenewalRequest) + findOne liens"
```

---

## Task 2 : Refus + acceptation automatique à la signature

**Files:** `refuse-renewal.dto.ts`, `contracts.service.ts`, `contracts.controller.ts`, `docuseal-webhook.service.ts`, tests (ajouts à `renew-contract.test.ts`).

**Interfaces:**
- Produces: `POST /v1/contracts/:id/renew/refuse` → `{ status:'REFUSED' }` (délie le parent). Hook : à la signature d'un successeur, sa `RenewalRequest` PENDING passe ACCEPTED.

- [ ] **Step 1 : tests qui échouent** — ajouter à `renew-contract.test.ts` :

```typescript
describe('POST /v1/contracts/:id/renew/refuse', () => {
  test('refuse → REFUSED + motif + délie le parent', async () => {
    const id = await seedActive();
    await renew(id).expect(201);
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/renew/refuse`).set('x-lsi-session', 'sess-am').send({ reason: 'Client non intéressé' }).expect(201);
    const [parent, rr] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { successorContractId: true } }),
      await tx.renewalRequest.findFirst({ where: { contractId: id } }),
    ]);
    expect(parent!.successorContractId).toBeNull();
    expect(rr).toMatchObject({ status: 'REFUSED', refusalReason: 'Client non intéressé' });
  });
  test('refuser sans renouvellement en cours → 409', async () => {
    const id = await seedActive();
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/renew/refuse`).set('x-lsi-session', 'sess-am').send({ reason: 'x' }).expect(409);
  });
});
```

Pour l'auto-ACCEPTED, ajouter un test au fichier webhook existant `apps/api/tests/isolation/docuseal-webhook.test.ts` (réutiliser ses helpers HMAC/seed) : monter un contrat successeur (`predecessorContractId` posé) en `PENDING_SIGNATURE` avec une `RenewalRequest` PENDING (`newContractId` = ce successeur), livrer un `FORM_COMPLETED` qui complète toutes les signatures → la `RenewalRequest` passe **ACCEPTED**. *(Suivre exactement les conventions du fichier ; si le montage d'un successeur signable y est trop lourd, tester la logique d'acceptation via un appel direct au service de webhook — au choix de l'implémenteur, mais l'assertion `status==='ACCEPTED'` doit être réelle.)*

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : DTO + refuse**

```typescript
// apps/api/src/contracts/dto/refuse-renewal.dto.ts
import { IsString, MinLength, MaxLength } from 'class-validator';
export class RefuseRenewalDto {
  @IsString() @MinLength(1, { message: 'Un motif est obligatoire.' }) @MaxLength(2000)
  reason!: string;
}
```

`contracts.service.ts` :
```typescript
  async refuseRenewal(scope: Scope, id: string, reason: string, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const parent = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!parent) throw new NotFoundException('Contrat introuvable');
      const rr = await tx.renewalRequest.findFirst({ where: { contractId: id, status: 'PENDING' } });
      if (!rr) throw new ConflictException({ code: 'NO_PENDING_RENEWAL', detail: 'Aucun renouvellement en cours.' });
      await tx.renewalRequest.update({ where: { id: rr.id }, data: { status: 'REFUSED', refusalReason: reason, decidedAt: now } });
      await tx.contract.update({ where: { id }, data: { successorContractId: null, updatedAt: now } });
      return { status: 'REFUSED' as const };
    });
  }
```

Contrôleur : `@Post(':id/renew/refuse')` (réutiliser un DTO à `reason` — soit `RefuseRenewalDto`, soit le `ReasonDto` déjà présent dans le contrôleur), `assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`, appelle `refuseRenewal(scope, id, dto.reason, session, now)`.

- [ ] **Step 4 : hook ACCEPTED (webhook)**

Dans `docuseal-webhook.service.ts`, cas `FORM_COMPLETED`, **après** `await this.transition(tx, sigReq.contractId, { type:'SIGNER_SIGNED', allSigned }, now)` et **si `allSigned`** :
```typescript
        if (allSigned) {
          const signed = await tx.contract.findUnique({ where: { id: sigReq.contractId }, select: { predecessorContractId: true } });
          if (signed?.predecessorContractId) {
            await tx.renewalRequest.updateMany({
              where: { newContractId: sigReq.contractId, status: 'PENDING' },
              data: { status: 'ACCEPTED', decidedAt: now },
            });
          }
        }
```
(Placé dans la même transaction ; `updateMany` sur PENDING → idempotent, no-op si déjà décidé.)

- [ ] **Step 5 : lancer, vérifier le succès + suite complète** (`apps/api` entier — le hook touche le webhook partagé). typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts apps/api/src/webhooks/docuseal-webhook.service.ts apps/api/tests
git commit -m "feat(renouvellements): refus (REFUSED + délie parent) + acceptation auto à la signature du successeur"
```

---

## Task 3 : Front — Renouveler / bandeaux / Refuser

**Files:** `apps/web/src/features/contracts/renew-contract.tsx`, `contract-detail-page.tsx`, test.

**Interfaces:**
- Consumes: `POST /renew`, `POST /renew/refuse`, et les champs `findOne` `renewal`/`predecessor` + `contract.status`.
- Produces: `<RenewContract contractId status roles renewal predecessor />`.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/renew-contract.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RenewContract } from '../features/contracts/renew-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
const base = { contractId: 'k1', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], renewal: null, predecessor: null };

test('bouton Renouveler pour un contrat ACTIVE sans renouvellement', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/renew');
    return new Response(JSON.stringify({ id: 'new1', reference: 'LSI-2027-0001' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<RenewContract {...base} />);
  await userEvent.click(screen.getByRole('button', { name: /Renouveler/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau + Refuser quand un renouvellement PENDING existe', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/renew/refuse');
    return new Response(JSON.stringify({ status: 'REFUSED' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<RenewContract {...base} renewal={{ status: 'PENDING', newContractId: 'new1', successor: { reference: 'LSI-2027-0001', status: 'DRAFT' } }} />);
  expect(screen.getByText(/LSI-2027-0001/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Refuser/ }));
  await userEvent.type(screen.getByLabelText(/Motif/), 'Non');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer le refus/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau prédécesseur pour un successeur', () => {
  wrap(<RenewContract {...base} status="DRAFT" predecessor={{ id: 'p1', reference: 'LSI-2026-0009' }} />);
  expect(screen.getByText(/Renouvellement de/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0009/)).toBeInTheDocument();
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : composant**

```tsx
// apps/web/src/features/contracts/renew-contract.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];
interface Ref { id?: string; reference: string; status?: string; }
interface Renewal { status: string; newContractId: string | null; successor: Ref | null; }

export function RenewContract({ contractId, status, roles, renewal, predecessor }: {
  contractId: string; status: string; roles: string[];
  renewal: Renewal | null; predecessor: { id: string; reference: string } | null;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState('');
  const canAct = roles.some((r) => ADMIN_OR_AM.includes(r));

  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/v1/contracts/${contractId}/renew`, {}),
    onSuccess: (r) => nav(`/contracts/${r.id}`),
  });
  const refuse = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/renew/refuse`, { reason: reason.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); setRefusing(false); },
  });

  const errOf = (m: typeof create | typeof refuse) => (m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined);
  const renewable = (status === 'ACTIVE' || status === 'EXPIRED') && !renewal;
  const active = renewal && renewal.status === 'PENDING';

  return (
    <div className="space-y-2">
      {predecessor && (
        <p className="text-sm text-gray-600">Renouvellement de <Link className="text-lsi hover:underline" to={`/contracts/${predecessor.id}`}>{predecessor.reference}</Link></p>
      )}
      {renewal && renewal.successor && (
        <p className="text-sm text-gray-600">
          Renouvellement → {renewal.newContractId
            ? <Link className="text-lsi hover:underline" to={`/contracts/${renewal.newContractId}`}>{renewal.successor.reference}</Link>
            : renewal.successor.reference} ({renewal.status})
        </p>
      )}
      {canAct && renewable && (
        <button type="button" disabled={create.isPending} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => create.mutate()}>
          {create.isPending ? 'Création…' : 'Renouveler'}
        </button>
      )}
      {errOf(create) && <p className="text-sm text-red-600">{errOf(create)}</p>}
      {canAct && active && !refusing && (
        <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setRefusing(true)}>Refuser</button>
      )}
      {refusing && (
        <div className="space-y-2 rounded border p-3">
          <label className="block text-sm">Motif du refus
            <textarea aria-label="Motif" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {errOf(refuse) && <p className="text-sm text-red-600">{errOf(refuse)}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!reason.trim() || refuse.isPending} className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => refuse.mutate()}>Confirmer le refus</button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setRefusing(false)}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : intégrer** dans `contract-detail-page.tsx` près des actions de cycle de vie : `<RenewContract contractId={data.contract.id} status={data.contract.status} roles={me.data?.roles ?? []} renewal={data.renewal} predecessor={data.predecessor} />` (adapter les noms `data`/`me` réels de la page).

- [ ] **Step 5 : lancer** — `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 6 : Commit** — `git add apps/web/src && git commit -m "feat(web): renouvellements — bouton Renouveler, bandeaux de liaison, refus"`

---

## Clôture

- [ ] Suites : `packages/domain`, `apps/api`, `@lsi/web` — vertes. CI locale (`pnpm lint && pnpm typecheck && pnpm test`) verte.
- [ ] Merge `main` → CI → redéploiement (env live préservé). **Aucune migration.**
