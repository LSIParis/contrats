# Phase E — Avenants (§6.12) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Créer un avenant (contrat AMENDMENT pré-rempli portant les nouvelles valeurs), qui suit le cycle normal, et reporter ses champs sur le parent à la signature (RM-18) avec régénération des rappels (EC-12), + l'UI.

**Architecture:** API `amend` (garde domaine `assertCanAmend` existante + P2002 sur l'index `contracts_one_open_amendment`). Hook RM-18 au webhook (report `endDate`/`amountCents` au parent + `replanAfterEndDateChange`). `findOne` expose les liens. Front : bouton Créer un avenant + bandeaux.

**Tech Stack:** NestJS 10, Prisma 5, domaine TS pur, React 18, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité** : scopé (`withScope`) ; 404 hors scope (jamais 403) ; 403 rôle (`assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`) ; 409 garde/état. Front visibilité seulement.
- Domaine **inchangé** : `assertCanAmend(parent)` (RM-17 ACTIVE/SIGNED ; RM-19 pas d'avenant ouvert), `replanAfterEndDateChange(c, now)`, `ContractType='AMENDMENT'` existent déjà. **Aucune migration** (index `contracts_one_open_amendment`, CHECK `amendment_has_parent`, enums préexistants).
- Le webhook déduplique les événements (EC-05 : `signature_events.providerEventId` unique → `duplicate_ignored`) → le hook RM-18 tourne **une seule fois** par événement.
- Rappels : statut `CANCELLED` pour annuler les PENDING ; unique `(contract_id, kind, offset_days, cycle)` ; `replanAfterEndDateChange` bumpe `reminderCycle`.
- Pattern de test API : `SessionService.put` + `x-lsi-session` ; `seedTwoCustomers` ; `adminScope`/`internalScope`/`withScope`/`uuidv7`.

---

## Structure de fichiers

- Create: `apps/api/src/contracts/dto/amend-contract.dto.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts` (`amend`, `findOne` augmenté), `apps/api/src/contracts/contracts.controller.ts`
- Modify: `apps/api/src/webhooks/docuseal-webhook.service.ts` (hook RM-18)
- Test: `apps/api/tests/isolation/amend-contract.test.ts`
- Create: `apps/web/src/features/contracts/amend-contract.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/amend-contract.test.tsx`

---

## Task 1 : API `amend` + `findOne` augmenté

**Files:** DTO + `contracts.service.ts` + `contracts.controller.ts` + `amend-contract.test.ts`.

**Interfaces:**
- Produces: `POST /v1/contracts/:id/amend` → `{ id, reference }` (crée un AMENDMENT DRAFT pré-rempli lié) ; `findOne` renvoie en plus `openAmendment` et `amends`.

- [ ] **Step 1 : DTO**

```typescript
// apps/api/src/contracts/dto/amend-contract.dto.ts
import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class AmendContractDto {
  @IsString() @MinLength(1, { message: 'Une description est obligatoire.' }) @MaxLength(2000)
  reason!: string;

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @IsInt() @Min(0)
  amountCents?: number;
}
```

- [ ] **Step 2 : test qui échoue**

```typescript
// apps/api/tests/isolation/amend-contract.test.ts
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
      id, tenantId: fx.tenantId, customerId, reference: `LSI-AV-${id.slice(-8)}`,
      title: 'Maintenance', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(100000), ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId, ...over } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}
const amend = (id: string, body: object, sess = 'sess-am') => request(app.getHttpServer()).post(`/v1/contracts/${id}/amend`).set('x-lsi-session', sess).send(body);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'sess-viewer', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
});

describe('POST /v1/contracts/:id/amend', () => {
  test('crée un AMENDMENT DRAFT pré-rempli avec les nouvelles valeurs + lien', async () => {
    const id = await seedActive();
    const res = await amend(id, { reason: 'Extension de périmètre', endDate: '2027-06-30', amountCents: 150000 }).expect(201);
    const newId = res.body.id;
    const av = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: newId }, select: { type: true, status: true, parentContractId: true, title: true, endDate: true, amountCents: true, category: true } }));
    expect(av).toMatchObject({ type: 'AMENDMENT', status: 'DRAFT', parentContractId: id, category: 'MAINTENANCE' });
    expect(av!.title).toContain('avenant');
    expect(av!.endDate?.toISOString().slice(0, 10)).toBe('2027-06-30');
    expect(av!.amountCents).toBe(BigInt(150000));
  });

  test('valeurs omises → copiées du parent', async () => {
    const id = await seedActive();
    const newId = (await amend(id, { reason: 'Simple avenant' }).expect(201)).body.id;
    const av = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: newId }, select: { endDate: true, amountCents: true } }));
    expect(av!.endDate?.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(av!.amountCents).toBe(BigInt(100000));
  });

  test('avenant sur un DRAFT → 409 (RM-17)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    const res = await amend(id, { reason: 'x' }); expect(res.status).toBe(409); expect(res.body.rule).toBe('RM-17');
  });

  test('second avenant en cours → 409 (RM-19)', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'premier' }).expect(201);
    const res = await amend(id, { reason: 'second' }); expect(res.status).toBe(409);
  });

  test('rôle insuffisant → 403', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'x' }, 'sess-viewer').expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'x' }, 'sess-am-b').expect(404);
  });

  test('findOne expose openAmendment (parent) et amends (avenant)', async () => {
    const id = await seedActive();
    const newId = (await amend(id, { reason: 'x' }).expect(201)).body.id;
    const parentView = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(parentView.body.openAmendment).toMatchObject({ id: newId, status: 'DRAFT' });
    const avView = await request(app.getHttpServer()).get(`/v1/contracts/${newId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(avView.body.amends?.id).toBe(id);
  });
});
```

- [ ] **Step 3 : lancer, vérifier l'échec** — `cd apps/api && pnpm exec vitest run tests/isolation/amend-contract.test.ts` (FAIL : route absente).

- [ ] **Step 4 : service + contrôleur + findOne**

Dans `contracts.service.ts`, importer `assertCanAmend`, `BusinessRuleError`, `Session`. Ajouter :
```typescript
  async amend(scope: Scope, id: string, dto: AmendContractDto, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const parent = await tx.contract.findUnique({ where: { id }, include: { signers: { select: { party: true } }, attachments: { select: { id: true } }, amendments: { select: { status: true } } } });
      if (!parent) throw new NotFoundException('Contrat introuvable');
      try {
        assertCanAmend(this.toSnapshot(parent, null));
      } catch (e) {
        if (e instanceof BusinessRuleError) throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        throw e;
      }
      const newId = uuidv7();
      let amendment;
      try {
        amendment = await tx.contract.create({ data: {
          id: newId, tenantId: parent.tenantId, customerId: parent.customerId,
          reference: await this.nextReference(tx, parent.tenantId, now),
          title: `${parent.title} — avenant`, type: 'AMENDMENT', status: 'DRAFT',
          category: parent.category, currency: parent.currency, billingFrequency: parent.billingFrequency,
          noticePeriodDays: parent.noticePeriodDays, startDate: parent.startDate,
          endDate: dto.endDate ? new Date(dto.endDate) : parent.endDate,
          amountCents: dto.amountCents !== undefined ? BigInt(dto.amountCents) : parent.amountCents,
          parentContractId: parent.id, ownerUserId: session.userId,
          createdAt: now, updatedAt: now, createdByUserId: session.userId, updatedByUserId: session.userId,
        }});
      } catch (e: any) {
        if (e?.code === 'P2002') throw new ConflictException({ code: 'AMENDMENT_ALREADY_OPEN', detail: 'Un avenant est déjà en cours sur ce contrat.' });
        throw e;
      }
      return { id: newId, reference: amendment.reference };
    });
  }
```

Dans `findOne`, avant le `return`, ajouter :
```typescript
      const openAmendment = await tx.contract.findFirst({
        where: { parentContractId: id, type: 'AMENDMENT', status: { notIn: ['CANCELLED', 'DECLINED', 'TERMINATED', 'EXPIRED', 'RENEWED'] } },
        select: { id: true, reference: true, status: true },
      });
      const amends = c.parentContractId
        ? await tx.contract.findUnique({ where: { id: c.parentContractId }, select: { id: true, reference: true } })
        : null;
```
et ajouter `openAmendment,` et `amends,` au littéral retourné.

Dans `contracts.controller.ts` (importer `AmendContractDto`) :
```typescript
  @Post(':id/amend')
  async amend(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AmendContractDto) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.amend(scope, id, dto, session, new Date());
  }
```

- [ ] **Step 5 : lancer, vérifier le succès + suite** — `cd apps/api && pnpm exec vitest run tests/isolation/amend-contract.test.ts && pnpm exec vitest run` ; `pnpm -r exec tsc --noEmit` clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/contracts apps/api/tests/isolation/amend-contract.test.ts
git commit -m "feat(avenants): POST amend (AMENDMENT pré-rempli lié) + findOne openAmendment/amends"
```

---

## Task 2 : RM-18 — report au parent à la signature de l'avenant (EC-12)

**Files:** `docuseal-webhook.service.ts` + tests (webhook).

**Interfaces:**
- Produces: à la signature complète d'un avenant, le parent reçoit `endDate`/`amountCents` de l'avenant ; si le parent est ACTIVE, ses rappels PENDING sont annulés et régénérés sur la nouvelle date (`replanAfterEndDateChange`).

- [ ] **Step 1 : test qui échoue**

Ajouter au test webhook existant `apps/api/tests/isolation/docuseal-webhook.test.ts` (réutiliser ses helpers HMAC/seed/formEvent) un scénario : un **avenant** (`type='AMENDMENT'`, `parentContractId` posé, `endDate` nouvelle) en `PENDING_SIGNATURE`, dont le parent est **ACTIVE** avec des rappels PENDING ; livrer un `FORM_COMPLETED` qui complète toutes les signatures → assertions **réelles** : le parent a `endDate` = celle de l'avenant, ses anciens rappels PENDING sont `CANCELLED`, et de nouveaux rappels PENDING existent sur la nouvelle date. *(Si le montage complet est trop lourd, tester au minimum le report d'`endDate`/`amountCents` sur le parent ; l'assertion doit être réelle en base.)*

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : hook RM-18**

Dans `docuseal-webhook.service.ts`, importer `replanAfterEndDateChange` de `@lsi/domain` (et vérifier que `uuidv7` de `@lsi/persistence` est importé). Dans le cas `FORM_COMPLETED`, **dans le bloc `if (allSigned)`**, APRÈS le hook renouvellement existant :
```typescript
          // Avenant (§6.12, RM-18) : à la signature complète d'un avenant,
          // reporter ses champs sur le parent + régénérer ses rappels (EC-12).
          // Idempotent : l'événement webhook est dédupliqué (EC-05), donc ceci
          // ne s'exécute qu'une fois.
          const av = await tx.contract.findUnique({
            where: { id: sigReq.contractId },
            select: { type: true, parentContractId: true, endDate: true, amountCents: true },
          });
          if (av?.type === 'AMENDMENT' && av.parentContractId) {
            const parent = await tx.contract.findUnique({
              where: { id: av.parentContractId },
              select: { id: true, tenantId: true, customerId: true, status: true, noticePeriodDays: true, reminderCycle: true },
            });
            if (parent) {
              if (parent.status === 'ACTIVE' && av.endDate) {
                const { newCycle, reminders } = replanAfterEndDateChange(
                  { endDate: av.endDate, noticePeriodDays: parent.noticePeriodDays, reminderCycle: parent.reminderCycle },
                  now,
                );
                await tx.reminder.updateMany({ where: { contractId: parent.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                await tx.contract.update({ where: { id: parent.id }, data: { endDate: av.endDate, amountCents: av.amountCents, reminderCycle: newCycle, updatedAt: now } });
                for (const d of reminders) {
                  await tx.reminder.create({ data: {
                    id: uuidv7(), tenantId: parent.tenantId, customerId: parent.customerId, contractId: parent.id,
                    kind: d.kind, offsetDays: d.offsetDays, cycle: d.cycle, dueAt: d.dueAt, status: d.status, createdAt: now,
                  }});
                }
              } else {
                await tx.contract.update({ where: { id: parent.id }, data: { endDate: av.endDate, amountCents: av.amountCents, updatedAt: now } });
              }
            }
          }
```

- [ ] **Step 4 : lancer, vérifier le succès + suite complète** (`apps/api` entier — le hook touche le webhook partagé ; les tests webhook/renouvellement existants doivent rester verts). typecheck clean.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/webhooks/docuseal-webhook.service.ts apps/api/tests
git commit -m "feat(avenants): RM-18 report endDate/montant au parent à la signature + replan rappels (EC-12)"
```

---

## Task 3 : Front — Créer un avenant / bandeaux

**Files:** `apps/web/src/features/contracts/amend-contract.tsx`, `contract-detail-page.tsx`, test.

**Interfaces:**
- Consumes: `POST /amend`, et les champs `findOne` `openAmendment`/`amends` + `contract.status`.
- Produces: `<AmendContract contractId status roles openAmendment amends />`.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/amend-contract.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AmendContract } from '../features/contracts/amend-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
const base = { contractId: 'k1', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], openAmendment: null, amends: null };

test('Créer un avenant → formulaire → POST /amend', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/amend');
    return new Response(JSON.stringify({ id: 'av1', reference: 'LSI-2026-0002' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<AmendContract {...base} />);
  await userEvent.click(screen.getByRole('button', { name: /Créer un avenant/ }));
  await userEvent.type(screen.getByLabelText(/Description/), 'Extension');
  await userEvent.click(screen.getByRole('button', { name: /Créer l.avenant/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau quand un avenant est en cours', () => {
  wrap(<AmendContract {...base} openAmendment={{ id: 'av1', reference: 'LSI-2026-0002', status: 'DRAFT' }} />);
  expect(screen.getByText(/Avenant en cours/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0002/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Créer un avenant/ })).not.toBeInTheDocument();
});

test('bandeau parent pour un avenant', () => {
  wrap(<AmendContract {...base} status="DRAFT" amends={{ id: 'p1', reference: 'LSI-2026-0001' }} />);
  expect(screen.getByText(/Avenant de/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0001/)).toBeInTheDocument();
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : composant**

```tsx
// apps/web/src/features/contracts/amend-contract.tsx
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];

/** « 1500,50 » → 150050 centimes ; vide → undefined. */
function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

export function AmendContract({ contractId, status, roles, openAmendment, amends }: {
  contractId: string; status: string; roles: string[];
  openAmendment: { id: string; reference: string; status: string } | null;
  amends: { id: string; reference: string } | null;
}) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [amount, setAmount] = useState('');
  const canAct = roles.some((r) => ADMIN_OR_AM.includes(r));
  const amendable = (status === 'ACTIVE' || status === 'SIGNED') && !openAmendment;

  const m = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/v1/contracts/${contractId}/amend`, {
      reason: reason.trim(),
      ...(endDate ? { endDate } : {}),
      ...(eurosToCents(amount) !== undefined ? { amountCents: eurosToCents(amount) } : {}),
    }),
    onSuccess: (r) => nav(`/contracts/${r.id}`),
  });
  const err = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <div className="space-y-2">
      {amends && (
        <p className="text-sm text-gray-600">Avenant de <Link className="text-lsi hover:underline" to={`/contracts/${amends.id}`}>{amends.reference}</Link></p>
      )}
      {openAmendment && (
        <p className="text-sm text-gray-600">Avenant en cours → <Link className="text-lsi hover:underline" to={`/contracts/${openAmendment.id}`}>{openAmendment.reference}</Link> ({openAmendment.status})</p>
      )}
      {canAct && amendable && !open && (
        <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>Créer un avenant</button>
      )}
      {open && (
        <form className="space-y-3 rounded border p-4" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) m.mutate(); }}>
          <p className="text-sm font-medium">Nouvel avenant</p>
          <label className="block text-sm">Description
            <textarea aria-label="Description" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="flex gap-3">
            <label className="block text-sm">Nouvelle date de fin
              <input type="date" aria-label="Nouvelle date de fin" className="mt-1 w-full rounded border p-2" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="block text-sm">Nouveau montant (€)
              <input aria-label="Nouveau montant" className="mt-1 w-full rounded border p-2" placeholder="inchangé" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={!reason.trim() || m.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white disabled:opacity-50">
              {m.isPending ? 'Création…' : 'Créer l’avenant'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setOpen(false)}>Annuler</button>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : intégrer** dans `contract-detail-page.tsx` près des autres actions : `<AmendContract contractId={data.contract.id} status={data.contract.status} roles={me.data?.roles ?? []} openAmendment={data.openAmendment} amends={data.amends} />` (adapter les noms réels `data`/`me` de la page ; étendre l'interface `Detail` avec `openAmendment`/`amends`).

- [ ] **Step 5 : lancer** — `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 6 : Commit** — `git add apps/web/src && git commit -m "feat(web): avenants — bouton Créer un avenant + bandeaux de liaison"`

---

## Clôture

- [ ] Suites : `apps/api`, `@lsi/web` — vertes. CI locale (`pnpm lint && pnpm typecheck && pnpm test`) verte.
- [ ] Merge `main` → CI → redéploiement (env live préservé). **Aucune migration.**
