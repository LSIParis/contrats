# Archivage + recherche par client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Câbler l'archivage (archiver/désarchiver un contrat terminé, exclure les archivés de la liste par défaut, vue « archivés ») et étendre `?q=` au nom du client.

**Architecture:** Endpoints d'action `POST /:id/archive|unarchive` (attribut orthogonal au statut, pas un événement du domaine) + filtre `archived` et exclusion par défaut dans `list` + clause de recherche `customer.name`. Frontend : bascule Archivés sur la liste, bouton Archiver/Désarchiver sur la fiche. Aucune migration.

**Tech Stack:** NestJS (SWC), Prisma + RLS, `withScope` ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- Toute requête DB via `withScope(scope, tx => …)`. RLS filtre le scope ; 404 hors scope.
- Archive réservé aux **statuts terminaux** : `TERMINATED, EXPIRED, CANCELLED, DECLINED, RENEWED`. Sinon **409** (`NOT_TERMINAL`).
- Rôles archive/unarchive : `['MSP_ADMIN', 'ACCOUNT_MANAGER']` via `assertRole`.
- Liste : exclut les archivés par défaut (`archivedAt IS NULL`) ; `?archived=true` → seulement les archivés (`archivedAt IS NOT NULL`).
- Idempotence : archiver un déjà-archivé / désarchiver un non-archivé → no-op 200.
- Recherche `?q=` : `reference` OU `title` OU `customer.name` (contains, `mode:'insensitive'`).
- Pas de migration (`archivedAt` existe). Imports ESM `.js`. Les POST sont audités automatiquement (intercepteur §6.9).

---

### Task 1: API — archive/unarchive + exclusion liste + recherche client

**Files:**
- Modify: `apps/api/src/contracts/contracts.service.ts` (méthodes `archive`/`unarchive`, `list` : exclusion + filtre + recherche client)
- Modify: `apps/api/src/contracts/contracts.controller.ts` (routes archive/unarchive)
- Modify: `apps/api/src/contracts/dto/list-contracts.dto.ts` (champ `archived`)
- Test: `apps/api/tests/isolation/archive-contract.test.ts`

**Interfaces:**
- Produces : `ContractsService.archive(scope, id, actorUserId, now)` / `unarchive(...)` → `{ ok: true }`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/archive-contract.test.ts` :

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

async function seedContract(status: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AR-${id.slice(-8)}`,
    title: 'À archiver', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await s.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('archivage des contrats', () => {
  test('archiver un contrat terminé pose archivedAt ; il sort de la liste par défaut', async () => {
    const id = await seedContract('TERMINATED');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(201);
    const list = await req('sess-am', 'get', '/v1/contracts').expect(200);
    expect(list.body.data.some((c: any) => c.id === id)).toBe(false);
    const arch = await req('sess-am', 'get', '/v1/contracts?archived=true').expect(200);
    expect(arch.body.data.some((c: any) => c.id === id)).toBe(true);
  });

  test('archiver un contrat non terminal (ACTIVE) → 409', async () => {
    const id = await seedContract('ACTIVE');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(409);
  });

  test('désarchiver le remet dans la liste par défaut', async () => {
    const id = await seedContract('EXPIRED');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(201);
    await req('sess-am', 'post', `/v1/contracts/${id}/unarchive`).expect(201);
    const list = await req('sess-am', 'get', '/v1/contracts').expect(200);
    expect(list.body.data.some((c: any) => c.id === id)).toBe(true);
  });

  test('un rôle non autorisé (TECHNICIAN) → 403', async () => {
    const id = await seedContract('TERMINATED');
    await req('sess-tech', 'post', `/v1/contracts/${id}/archive`).expect(403);
  });

  test('la recherche matche le nom du client', async () => {
    await seedContract('ACTIVE'); // client Dupont SAS
    const res = await req('sess-am', 'get', '/v1/contracts?q=Dupont').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((c: any) => c.customer.name.includes('Dupont'))).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/api test -- archive-contract`
Expected: FAIL (routes absentes → 404 ; recherche client absente).

- [ ] **Step 3: DTO — champ `archived`**

Dans `apps/api/src/contracts/dto/list-contracts.dto.ts`, ajouter (après `q`) :

```ts
  /** Vue archivés : true → seulement les archivés ; absent/false → seulement les actifs. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  archived?: boolean;
```

Et compléter les imports : `IsBoolean` depuis `class-validator` (ajouter à la liste existante).

- [ ] **Step 4: Service — archive/unarchive + list**

Dans `apps/api/src/contracts/contracts.service.ts` :

Ajouter une constante en tête de classe (ou module) :

```ts
const TERMINAL_STATUSES = ['TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'RENEWED'];
```

Ajouter les méthodes (dans la classe) :

```ts
  async archive(scope: Scope, id: string, actorUserId: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true, status: true, archivedAt: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (c.archivedAt) return { ok: true as const }; // idempotent
      if (!TERMINAL_STATUSES.includes(c.status)) {
        throw new ConflictException({ code: 'NOT_TERMINAL', detail: 'Seuls les contrats terminés peuvent être archivés.' });
      }
      await tx.contract.update({ where: { id }, data: { archivedAt: now, updatedAt: now, updatedByUserId: actorUserId } });
      return { ok: true as const };
    });
  }

  async unarchive(scope: Scope, id: string, actorUserId: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!c.archivedAt) return { ok: true as const }; // idempotent
      await tx.contract.update({ where: { id }, data: { archivedAt: null, updatedAt: now, updatedByUserId: actorUserId } });
      return { ok: true as const };
    });
  }
```

Vérifier que `ConflictException` est importé de `@nestjs/common` (ajouter si absent).

Dans `list`, après le bloc `if (q.cursor)` et avant le bloc `if (q.q?.trim())`, ajouter l'exclusion :

```ts
      where.archivedAt = q.archived ? { not: null } : null;
```

Et étendre la recherche (bloc `if (q.q?.trim())`) :

```ts
      if (q.q?.trim()) {
        const term = q.q.trim();
        where.OR = [
          { reference: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } },
        ];
      }
```

- [ ] **Step 5: Contrôleur — routes archive/unarchive**

Dans `apps/api/src/contracts/contracts.controller.ts`, ajouter deux routes (près des autres actions) :

```ts
  @Post(':id/archive')
  async archive(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.archive(scope, id, session.userId, new Date());
  }

  @Post(':id/unarchive')
  async unarchive(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.unarchive(scope, id, session.userId, new Date());
  }
```

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- archive-contract`
Expected: PASS (5/5).

- [ ] **Step 7: Non-régression recherche + liste**

Run: `pnpm --filter @lsi/api test -- contracts-search contracts-list allowed-and-detail`
Expected: PASS (l'exclusion par défaut ne casse pas les listes existantes — les contrats seedés ne sont pas archivés).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/contracts apps/api/tests/isolation/archive-contract.test.ts
git commit -m "feat(contracts): archivage (archive/unarchive terminaux, exclusion liste, vue archivés) + recherche nom client"
```

---

### Task 2: Frontend — bascule Archivés (liste) + bouton Archiver (fiche)

**Files:**
- Modify: `apps/web/src/features/contracts/contracts-page.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/archive-contract.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `apiPost` ; endpoints Task 1 ; `useMe` pour le rôle.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/archive-contract.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContractsPage } from '../features/contracts/contracts-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('la bascule « Archivés » ajoute ?archived=true à la requête', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [], pagination: { nextCursor: null, hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<ContractsPage />);
  await waitFor(() => expect(screen.getByLabelText(/Archivés/i)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText(/Archivés/i));
  await waitFor(() => expect(calls.some((c) => c.includes('archived=true'))).toBe(true));
});
```

- [ ] **Step 2: Lancer — échoue**

Run: `pnpm --filter @lsi/web test -- archive-contract`
Expected: FAIL (bascule absente).

- [ ] **Step 3: Liste — bascule Archivés**

Dans `apps/web/src/features/contracts/contracts-page.tsx` :
- Ajouter un état : `const [archived, setArchived] = useState(false);`
- Inclure `archived` dans la `queryKey` : `queryKey: ['contracts', status, q, archived]`.
- Dans `queryFn`, après le bloc `q` : `if (archived) sp.set('archived', 'true');`.
- Ajouter, à côté de l'input de recherche, une case à cocher :

```tsx
      <label className="ml-3 inline-flex items-center gap-1 text-sm text-gray-600">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archivés
      </label>
```

- [ ] **Step 4: Fiche — bouton Archiver / Désarchiver**

Dans `apps/web/src/features/contracts/contract-detail-page.tsx` :
- Ajouter `archivedAt: string | null;` à l'interface `Detail.contract`.
- Importer `apiPost` (si absent) et `useMe` (déjà utilisé ailleurs ? sinon `import { useMe } from '../../lib/queries.js';`) + `useQueryClient`.
- Définir en tête du module : `const TERMINAL = ['TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'RENEWED'];`
- Dans le composant : `const me = useMe(); const qc = useQueryClient();`
  `const canArchive = me.data?.roles?.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r)) ?? false;`
  `const archiveAct = (verb: 'archive' | 'unarchive') => apiPost(\`/v1/contracts/${contract.id}/${verb}\`, {}).then(() => qc.invalidateQueries({ queryKey: ['contract', id] }));`
- Dans le rendu (près de l'en-tête / des actions), afficher :

```tsx
      {contract.archivedAt ? (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>Archivé le {new Date(contract.archivedAt).toLocaleDateString('fr-FR')}</span>
          {canArchive && <button type="button" className="text-lsi underline" onClick={() => archiveAct('unarchive')}>Désarchiver</button>}
        </div>
      ) : (
        canArchive && TERMINAL.includes(contract.status) && (
          <button type="button" className="text-lsi underline text-sm" onClick={() => archiveAct('archive')}>Archiver</button>
        )
      )}
```

*(Placer ce bloc là où les autres actions de la fiche sont rendues, en suivant la mise en page existante.)*

- [ ] **Step 5: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- archive-contract`
Expected: PASS.

- [ ] **Step 6: Non-régression + build**

Run: `pnpm --filter @lsi/web test -- contracts && pnpm --filter @lsi/web build`
Expected: PASS + build OK.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/contracts/contracts-page.tsx apps/web/src/features/contracts/contract-detail-page.tsx apps/web/src/test/archive-contract.test.tsx
git commit -m "feat(web/contracts): bascule Archivés (liste) + bouton Archiver/Désarchiver (fiche, terminaux)"
```

---

## Self-Review

**Spec coverage :**
- §3.1 archive/unarchive (terminal 409, idempotent, rôles) → Task 1 ✅
- §3.2 exclusion liste + filtre `archived` → Task 1 ✅
- §3.3 recherche nom client → Task 1 ✅
- §4.1 fiche (bouton + état archivé) → Task 2 ✅ ; §4.2 liste (bascule) → Task 2 ✅
- §5 sécurité (403 rôle, 409 non-terminal, exclusion, 404 scope) → tests Task 1 ✅

**Placeholders :** aucun. Task 2 Steps 3-4 décrivent les insertions avec le code exact ; le placement suit la mise en page existante.

**Cohérence des types :** `archive`/`unarchive` (service Task 1) ↔ routes contrôleur ↔ appels front `apiPost('/v1/contracts/:id/archive|unarchive')`. `archived` (DTO) ↔ `?archived=true` (front). `contract.archivedAt` déjà renvoyé par `findOne`, typé côté front en Task 2. `TERMINAL_STATUSES` (back) == `TERMINAL` (front) — mêmes 5 valeurs.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
