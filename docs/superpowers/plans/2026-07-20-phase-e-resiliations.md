# Phase E — Résiliations (§6.13) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Résilier un contrat ACTIVE/SIGNED (motif + date d'effet + préavis, dérogation admin tracée), en enregistrant l'acte dans `cancellations` ; tracer aussi l'annulation existante.

**Architecture:** Le domaine (`TERMINATE`) et le schéma (`cancellations`) existent déjà. On ajoute l'endpoint `POST /contracts/:id/terminate` + sa persistance, on fait écrire un `Cancellation` à `cancel`, et une UI « Résilier » avec confirmation nommée.

**Tech Stack:** NestJS 10, Prisma 5, domaine TS pur, React 18, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité** : endpoints scopés (`withScope`) ; **404 (jamais 403) hors scope** (RM-30) ; **403** rôle (`assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`) ; **409** transition invalide / RM-20. `isAdmin = session.roles.includes('MSP_ADMIN')` — seul un admin déroge au préavis, avec `overrideReason` tracé. Le front ne porte AUCUNE autorisation.
- UI en français. CI (`lint`+`typecheck`+`test`) verte.
- Enums existants : `CancellationType` {CANCELLATION, TERMINATION}, `InitiatedBy` {LSI, CLIENT}.
- **Aucune migration.** Domaine inchangé (pas de nouveau test domaine).
- Pattern de test API : `SessionService.put(...)` + en-tête `x-lsi-session` ; fixture `seedTwoCustomers` (`fx.tenantId, fx.amUserId, fx.amBUserId, fx.adminUserId, fx.customerA.{id}, fx.customerB.{id}`) ; `adminScope`/`internalScope`/`withScope`/`uuidv7` de `@lsi/persistence`.

---

## Structure de fichiers

- Create: `apps/api/src/contracts/dto/terminate-contract.dto.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts` (méthode `terminate` + persistance `Cancellation` sur `CANCEL`)
- Modify: `apps/api/src/contracts/contracts.controller.ts` (route `terminate`)
- Test: `apps/api/tests/isolation/terminate-contract.test.ts`
- Create: `apps/web/src/features/contracts/terminate-contract.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/terminate-contract.test.tsx`

---

## Task 1 : API — résiliation + traçage des annulations

**Files:**
- Create: `apps/api/src/contracts/dto/terminate-contract.dto.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts`, `apps/api/src/contracts/contracts.controller.ts`
- Test: `apps/api/tests/isolation/terminate-contract.test.ts`

**Interfaces:**
- Produces: `POST /v1/contracts/:id/terminate` → `{ status:'TERMINATED', effectiveDate, noticeRespected }`. Écrit un `Cancellation` (type=TERMINATION). L'endpoint `cancel` existant écrit un `Cancellation` (type=CANCELLATION).

- [ ] **Step 1 : DTO**

```typescript
// apps/api/src/contracts/dto/terminate-contract.dto.ts
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TerminateContractDto {
  @IsString()
  @MinLength(1, { message: 'Un motif est obligatoire.' })
  @MaxLength(2000)
  reason!: string;

  @IsDateString()
  effectiveDate!: string;

  @IsEnum(['LSI', 'CLIENT'])
  initiatedBy!: 'LSI' | 'CLIENT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  overrideReason?: string;
}
```

- [ ] **Step 2 : test qui échoue**

```typescript
// apps/api/tests/isolation/terminate-contract.test.ts
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

/** Un contrat ACTIVE (résiliable) chez customerA, préavis 30 j. */
async function seedActive(over: Record<string, unknown> = {}, customer = { id: '' }) {
  const id = uuidv7();
  const vId = uuidv7();
  const now = new Date();
  const cid = customer.id || fx.customerA.id;
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: cid, reference: `LSI-RES-${id.slice(-8)}`,
      title: 'Contrat actif', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
      signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      ...over,
    }});
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId: cid, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}

const plus = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
});

const term = (id: string, body: object, sess = 'sess-am') =>
  request(app.getHttpServer()).post(`/v1/contracts/${id}/terminate`).set('x-lsi-session', sess).send(body);

async function cancellations(contractId: string) {
  return withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.cancellation.findMany({ where: { contractId } }));
}

describe('POST /v1/contracts/:id/terminate', () => {
  test('résilie en respectant le préavis → TERMINATED + Cancellation(TERMINATION)', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Fin de collaboration', effectiveDate: plus(31), initiatedBy: 'CLIENT' }).expect(201);
    expect(res.body.status).toBe('TERMINATED');
    expect(res.body.noticeRespected).toBe(true);
    const [c, canc] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { status: true, terminatedAt: true } }),
      await tx.cancellation.findMany({ where: { contractId: id } }),
    ]);
    expect(c!.status).toBe('TERMINATED');
    expect(c!.terminatedAt).toBeTruthy();
    expect(canc).toHaveLength(1);
    expect(canc[0]).toMatchObject({ type: 'TERMINATION', initiatedBy: 'CLIENT', noticeRespected: true });
  });

  test('motif vide → 409 RM-20, rien ne bouge', async () => {
    const id = await seedActive();
    await term(id, { reason: '', effectiveDate: plus(31), initiatedBy: 'LSI' }).expect(400); // MinLength -> 400 validation
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id }, select: { status: true } }));
    expect(c!.status).toBe('ACTIVE');
  });

  test('préavis non respecté SANS admin → 409 RM-20', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Trop tôt', effectiveDate: plus(5), initiatedBy: 'LSI' }, 'sess-am');
    expect(res.status).toBe(409);
    expect(res.body.rule).toBe('RM-20');
    expect(await cancellations(id)).toHaveLength(0);
  });

  test('préavis non respecté AVEC admin + justification → succès, noticeRespected=false, override tracé', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Manquement grave', effectiveDate: plus(5), initiatedBy: 'LSI', overrideReason: 'Résiliation pour faute' }, 'sess-admin').expect(201);
    expect(res.body.noticeRespected).toBe(false);
    const canc = await cancellations(id);
    expect(canc[0]).toMatchObject({ noticeRespected: false, overrideReason: 'Résiliation pour faute', overrideByUserId: fx.adminUserId });
  });

  test('préavis non respecté AVEC admin SANS justification → 409 RM-20', async () => {
    const id = await seedActive();
    await term(id, { reason: 'x', effectiveDate: plus(5), initiatedBy: 'LSI' }, 'sess-admin').expect(409);
  });

  test('résilier un DRAFT → 409 (transition invalide)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    await term(id, { reason: 'x', effectiveDate: plus(31), initiatedBy: 'LSI' }).expect(409);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await term(id, { reason: 'x', effectiveDate: plus(31), initiatedBy: 'LSI' }, 'sess-am-b').expect(404);
  });
});

describe('POST /v1/contracts/:id/cancel — trace l\'annulation', () => {
  test('annuler un DRAFT écrit un Cancellation(CANCELLATION)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/cancel`).set('x-lsi-session', 'sess-am').send({ reason: 'Erreur de saisie' }).expect(201);
    const canc = await cancellations(id);
    expect(canc).toHaveLength(1);
    expect(canc[0]).toMatchObject({ type: 'CANCELLATION', reason: 'Erreur de saisie' });
  });
});
```

- [ ] **Step 3 : lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/terminate-contract.test.ts`
Expected: FAIL (route `terminate` absente → 404 ; `cancel` n'écrit pas de Cancellation).

- [ ] **Step 4 : implémenter le service**

Dans `contracts.service.ts`, importer le type `Session` (`import type { Session } from '../auth/session.service.js';`) et ajouter la méthode :

```typescript
  async terminate(scope: Scope, id: string, dto: TerminateContractDto, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        include: { signers: { select: { party: true } }, attachments: { select: { id: true } }, amendments: { select: { status: true } } },
      });
      if (!c) throw new NotFoundException('Contrat introuvable'); // RLS -> 404 hors scope

      const effectiveDate = new Date(dto.effectiveDate);
      const isAdmin = session.roles.includes('MSP_ADMIN');
      const snapshot = this.toSnapshot(c, null);
      try {
        applyEvent(snapshot, { type: 'TERMINATE', actorUserId: session.userId, reason: dto.reason, effectiveDate, isAdmin, overrideReason: dto.overrideReason }, now);
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          throw new ConflictException({ code: e.code, detail: e.message, currentStatus: e.currentStatus, allowedTransitions: e.allowedTransitions });
        }
        if (e instanceof BusinessRuleError) {
          throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        }
        throw e;
      }

      const noticeMin = new Date(now);
      noticeMin.setDate(noticeMin.getDate() + (c.noticePeriodDays ?? 0));
      const noticeRespected = effectiveDate >= noticeMin;

      await tx.cancellation.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
          type: 'TERMINATION', reason: dto.reason, initiatedBy: dto.initiatedBy,
          effectiveDate, noticeRespected,
          overrideReason: noticeRespected ? null : (dto.overrideReason ?? null),
          overrideByUserId: noticeRespected ? null : session.userId,
          createdByUserId: session.userId, createdAt: now,
        },
      });

      await tx.contract.update({
        where: { id },
        data: { status: 'TERMINATED', terminatedAt: now, updatedAt: now, updatedByUserId: session.userId },
      });

      return { status: 'TERMINATED' as const, effectiveDate: dto.effectiveDate, noticeRespected };
    });
  }
```

Dans le même fichier, dans `applyEvent(...)` générique, **avant** le `return tx.contract.update(...)` final, tracer l'annulation :

```typescript
      if (event.type === 'CANCEL') {
        await tx.cancellation.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
            type: 'CANCELLATION', reason: event.reason, initiatedBy: 'LSI',
            effectiveDate: now, noticeRespected: true,
            createdByUserId: event.actorUserId, createdAt: now,
          },
        });
      }
```

- [ ] **Step 5 : contrôleur**

Dans `contracts.controller.ts`, importer le DTO (`import { TerminateContractDto } from './dto/terminate-contract.dto.js';`) et ajouter :

```typescript
  @Post(':id/terminate')
  async terminate(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateContractDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.terminate(scope, id, dto, session, new Date());
  }
```

- [ ] **Step 6 : lancer, vérifier le succès + suite**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/terminate-contract.test.ts && pnpm exec vitest run` — vert.
`pnpm --filter @lsi/api exec tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 7 : Commit**

```bash
git add apps/api/src/contracts apps/api/tests/isolation/terminate-contract.test.ts
git commit -m "feat(api): résiliation (POST terminate) + traçage cancellations (résiliation & annulation)"
```

---

## Task 2 : Front — action Résilier (confirmation nommée)

**Files:**
- Create: `apps/web/src/features/contracts/terminate-contract.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/terminate-contract.test.tsx`

**Interfaces:**
- Consumes: `POST /v1/contracts/:id/terminate`. Produces `<TerminateContract contractId customerName noticePeriodDays roles allowedActions />`.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/terminate-contract.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminateContract } from '../features/contracts/terminate-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const props = { contractId: 'k1', customerName: 'ACME', noticePeriodDays: 30, roles: ['ACCOUNT_MANAGER'], allowedActions: ['TERMINATE'] };

test('rien si TERMINATE non autorisé', () => {
  wrap(<TerminateContract {...props} allowedActions={[]} />);
  expect(screen.queryByRole('button', { name: /Résilier/ })).not.toBeInTheDocument();
});

test('la confirmation exige le nom du client puis POST /terminate', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/terminate');
    return new Response(JSON.stringify({ status: 'TERMINATED', noticeRespected: true }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  await userEvent.type(screen.getByLabelText(/Motif/), 'Fin de contrat');
  // bouton confirmer désactivé tant que le nom ne correspond pas
  const confirm = screen.getByRole('button', { name: /Confirmer la résiliation/ });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});
```

- [ ] **Step 2 : lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/terminate-contract.test.tsx` → FAIL (module absent).

- [ ] **Step 3 : composant**

```tsx
// apps/web/src/features/contracts/terminate-contract.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];

function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TerminateContract({
  contractId, customerName, noticePeriodDays, roles, allowedActions,
}: {
  contractId: string; customerName: string; noticePeriodDays: number | null; roles: string[]; allowedActions: string[];
}) {
  const qc = useQueryClient();
  const notice = noticePeriodDays ?? 0;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [initiatedBy, setInitiatedBy] = useState<'LSI' | 'CLIENT'>('LSI');
  const [effectiveDate, setEffectiveDate] = useState(plusDays(notice));
  const [overrideReason, setOverrideReason] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const isAdmin = roles.includes('MSP_ADMIN');
  const canAct = allowedActions.includes('TERMINATE') && roles.some((r) => ADMIN_OR_AM.includes(r));
  const beforeNotice = effectiveDate < plusDays(notice);
  const needsOverride = beforeNotice; // le serveur refuse si non-admin ; le champ n'apparaît que pour l'admin

  const m = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/terminate`, {
      reason: reason.trim(), effectiveDate, initiatedBy,
      ...(isAdmin && beforeNotice ? { overrideReason: overrideReason.trim() } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setOpen(false);
    },
  });

  if (!canAct) return null;
  const err = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const nameOk = confirmName.trim() === customerName.trim();
  const overrideOk = !(isAdmin && beforeNotice) || overrideReason.trim().length > 0;
  const ready = reason.trim().length > 0 && nameOk && overrideOk && !m.isPending;

  if (!open) {
    return (
      <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setOpen(true)}>
        Résilier
      </button>
    );
  }

  return (
    <form className="space-y-3 rounded border border-red-200 p-4" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <p className="text-sm font-medium text-red-700">Résiliation du contrat</p>
      <label className="block text-sm">Motif
        <textarea aria-label="Motif" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <label className="block text-sm">Initié par
        <select className="mt-1 w-full rounded border p-2" value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value as 'LSI' | 'CLIENT')}>
          <option value="LSI">LSI</option>
          <option value="CLIENT">Client</option>
        </select>
      </label>
      <label className="block text-sm">Date d'effet {notice > 0 && <span className="text-gray-500">(préavis {notice} j → au plus tôt le {plusDays(notice)})</span>}
        <input type="date" aria-label="Date d'effet" className="mt-1 w-full rounded border p-2" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
      </label>
      {isAdmin && beforeNotice && (
        <label className="block text-sm text-amber-700">Justification de la dérogation au préavis (obligatoire)
          <textarea aria-label="Justification de la dérogation" className="mt-1 w-full rounded border p-2" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
        </label>
      )}
      {beforeNotice && !isAdmin && <p className="text-sm text-red-600">La date précède la fin du préavis : seul un administrateur peut déroger.</p>}
      <label className="block text-sm">Tapez le nom du client (<span className="font-medium">{customerName}</span>) pour confirmer
        <input aria-label={`Tapez le nom du client (${customerName})`} className="mt-1 w-full rounded border p-2" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
      </label>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!ready} className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
          {m.isPending ? 'Résiliation…' : 'Confirmer la résiliation'}
        </button>
        <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4 : intégrer dans la fiche**

Dans `contract-detail-page.tsx`, monter le composant près des actions de cycle de vie (là où `WorkflowActions`/`SignatureActions` sont rendus). `data` = réponse `findOne` : `contractId={data.contract.id}`, `customerName={data.customer.name}`, `noticePeriodDays={data.contract.noticePeriodDays}`, `roles={me.data?.roles ?? []}`, `allowedActions={allowed.data ?? []}` (utiliser la même source `allowed-actions` que les autres actions de la page).

```tsx
<TerminateContract
  contractId={data.contract.id}
  customerName={data.customer.name}
  noticePeriodDays={data.contract.noticePeriodDays}
  roles={me.data?.roles ?? []}
  allowedActions={allowedActions}
/>
```
(Adapter les noms `data`/`me`/`allowedActions` à ceux réellement utilisés dans la page.)

- [ ] **Step 5 : lancer, vérifier le succès + suites**

Run: `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): action Résilier (préavis, dérogation admin, confirmation nommée)"
```

---

## Clôture

- [ ] Suites : `cd apps/api && pnpm exec vitest run` ; `pnpm --filter @lsi/web test` — vert.
- [ ] CI locale : `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] Merge `main` → CI → redéploiement (env live préservé). **Aucune migration.**
