# Portail — Signature in-portal — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps en cases à cocher, TDD.

**Goal:** Un client connecté peut signer un contrat en attente : la fiche portail montre `mySignature`, un bouton **Signer** redirige (serveur) vers DocuSeal `/s/{slug}`, et une page `signature-complete` accueille le retour.

**Architecture:** API portail — `mySignature` sur le detail + `GET /v1/portal/contracts/:id/sign` (302 vers DocuSeal, slug côté serveur). Frontend — bouton Signer + page signature-complete. Aucun nouveau secret (DOCUSEAL_SIGN_URL déduit de DOCUSEAL_URL).

**Tech Stack:** NestJS 10, Prisma 5, React 18, React Router 6, TanStack Query 5, Vitest + supertest + Testcontainers, Testing Library.

## Global Constraints

- **Sécurité (§11.7, H11)** : le portail reste consultation + **signature seulement** ; l'endpoint `/sign` ne résout que le **propre** signataire du client (party=CLIENT, email de la session), sous RLS (404 hors scope) ; **slug jamais dans le JSON** ; 409 si pas de signature en attente (pas d'oracle). Sous `/v1/portal/*` (garde deny-by-default). La signature (identité, 2FA) reste chez DocuSeal.
- Statuts « en attente » = {SENT, VIEWED}. `DOCUSEAL_SIGN_URL = process.env.DOCUSEAL_SIGN_URL ?? (process.env.DOCUSEAL_URL ?? 'http://docuseal:3000/api').replace(/\/api\/?$/, '')`.
- **Aucune migration.** Le `Scope` porte `userId` ; `PortalService.emailOf(scope, userId)` existe déjà (increment 1). Pattern de test : session `clientScope(tenantId, customerId, userId)` + `x-lsi-session` ; `seedTwoCustomers`.

---

## Structure de fichiers

- Modify: `apps/api/src/portal/portal.service.ts` (mySignature + signRedirectUrl), `apps/api/src/portal/portal-contracts.controller.ts` (route /sign)
- Test: `apps/api/tests/isolation/portal-sign.test.ts`
- Modify: `apps/web/src/portal/portal-contract-page.tsx` (bouton Signer), `apps/web/src/portal/portal-app.tsx` (route signature-complete)
- Create: `apps/web/src/portal/portal-signature-complete-page.tsx`
- Test: `apps/web/src/test/portal-sign.test.tsx`

---

## Task 1 : API — `mySignature` + redirection de signature

**Files:** `portal.service.ts`, `portal-contracts.controller.ts`, `portal-sign.test.ts`.

**Interfaces:**
- Produces: `GET /v1/portal/contracts/:id` renvoie `mySignature: { status } | null` ; `GET /v1/portal/contracts/:id/sign` → 302 vers DocuSeal, 404/409 sinon.

- [ ] **Step 1 : test qui échoue**

```typescript
// apps/api/tests/isolation/portal-sign.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture; let clientUserId: string;
const CLIENT_EMAIL = 'signer-a@example.com';

async function seedSignableContract(signerStatus: string, slug: string | null) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-SG-${id.slice(-8)}`,
      title: 'À signer', type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    await tx.contractSigner.create({ data: {
      id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT',
      fullName: 'Nathalie', email: CLIENT_EMAIL, signingOrder: 1, status: signerStatus as any,
      providerSubmitterSlug: slug, createdAt: now, updatedAt: now } });
  });
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: CLIENT_EMAIL, fullName: 'Nathalie', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } }));
  await app.get(SessionService).put({ sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId) }, 1800);
});
const get = (path: string) => request(app.getHttpServer()).get(path).set('x-lsi-session', 'sess-client');

describe('signature in-portal', () => {
  test('la fiche expose mySignature.status pour le client', async () => {
    const id = await seedSignableContract('SENT', 'slug-abc');
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body.mySignature).toMatchObject({ status: 'SENT' });
  });

  test('/sign redirige (302) vers la page DocuSeal du signataire', async () => {
    const id = await seedSignableContract('SENT', 'slug-xyz');
    const res = await get(`/v1/portal/contracts/${id}/sign`).expect(302);
    expect(res.headers.location).toContain('/s/slug-xyz');
    // le slug n'est PAS dans le JSON de la fiche
    const detail = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain('slug-xyz');
  });

  test('déjà signé → /sign 409', async () => {
    const id = await seedSignableContract('SIGNED', 'slug-done');
    await get(`/v1/portal/contracts/${id}/sign`).expect(409);
  });

  test('client non signataire → mySignature null et /sign 404', async () => {
    // contrat sans signataire au nom du client
    const id = uuidv7(); const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-NS-${id.slice(-8)}`, title: 'X',
      type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
      ownerUserId: fx.amUserId, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body.mySignature).toBeNull();
    await get(`/v1/portal/contracts/${id}/sign`).expect(404);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : service**

Dans `portal.service.ts`, en tête :
```typescript
const SIGN_PENDING = ['SENT', 'VIEWED'];
function docusealSignBase(): string {
  return process.env.DOCUSEAL_SIGN_URL ?? (process.env.DOCUSEAL_URL ?? 'http://docuseal:3000/api').replace(/\/api\/?$/, '');
}
```
Dans `findOne(scope, id)`, avant le `return`, résoudre le signataire du client :
```typescript
      const email = await this.emailOf(scope, scope.userId);
      const mine = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email }, select: { status: true } })
        : null;
      const mySignature = mine ? { status: mine.status } : null;
```
et ajouter `mySignature,` au littéral retourné.

Nouvelle méthode :
```typescript
  async signRedirectUrl(scope: Scope, id: string): Promise<string> {
    const email = await this.emailOf(scope, scope.userId);
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable'); // RLS → 404 hors scope
      const signer = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email }, select: { status: true, providerSubmitterSlug: true } })
        : null;
      if (!signer) throw new NotFoundException('Vous n’êtes pas signataire de ce contrat.');
      if (!SIGN_PENDING.includes(signer.status) || !signer.providerSubmitterSlug) {
        throw new ConflictException({ code: 'NO_PENDING_SIGNATURE', detail: 'Aucune signature en attente pour vous sur ce contrat.' });
      }
      return `${docusealSignBase()}/s/${signer.providerSubmitterSlug}`;
    });
  }
```
(Importer `ConflictException` si absent.)

- [ ] **Step 4 : contrôleur**

Dans `portal-contracts.controller.ts`, ajouter la route (avec `@Res`) :
```typescript
  @Get('contracts/:id/sign')
  async sign(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const url = await this.portal.signRedirectUrl(scope, id);
    res.redirect(302, url);
  }
```
(Importer `Res` de `@nestjs/common` et `Response` d'`express`. `findOne` reste inchangé côté signature — il appelle déjà `this.portal.findOne(scope, id)` qui renvoie désormais `mySignature`.)

- [ ] **Step 5 : lancer, vérifier le succès + suite** — `cd apps/api && pnpm exec vitest run tests/isolation/portal-sign.test.ts && pnpm exec vitest run` ; typecheck clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/portal apps/api/tests/isolation/portal-sign.test.ts
git commit -m "feat(portail): signature in-portal — mySignature + redirection serveur vers DocuSeal (/s/slug)"
```

---

## Task 2 : Frontend — bouton Signer + page signature-complete

**Files:** `portal-contract-page.tsx`, `portal-app.tsx`, `portal-signature-complete-page.tsx`, `portal-sign.test.tsx`.

**Interfaces:**
- Consumes: `mySignature` sur la fiche ; `/v1/portal/contracts/:id/sign`. Produces: bouton Signer + route `/portal/signature-complete`.

- [ ] **Step 1 : test qui échoue**

```tsx
// apps/web/src/test/portal-sign.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalContractPage } from '../portal/portal-contract-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/portal/contracts/k1']}>{ui}</MemoryRouter></QueryClientProvider>);
}
const DETAIL = { reference: 'LSI-2026-0001', title: 'Maintenance', status: 'PENDING_SIGNATURE', endDate: '2026-12-31', amountCents: null, currency: 'EUR', signers: [{ party: 'CLIENT', fullName: 'Nathalie', status: 'SENT', signedAt: null }], mySignature: { status: 'SENT' } };

test('affiche un lien Signer quand une signature est en attente', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DETAIL), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractPage />);
  const link = await screen.findByRole('link', { name: /Signer le document/ });
  expect(link).toHaveAttribute('href', expect.stringContaining('/sign'));
});

test('pas de lien Signer si déjà signé', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...DETAIL, mySignature: { status: 'SIGNED' } }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractPage />);
  await screen.findByText(/Maintenance/);
  expect(screen.queryByRole('link', { name: /Signer le document/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**

- [ ] **Step 3 : bouton Signer** — dans `portal-contract-page.tsx`, étendre l'interface detail avec `mySignature: { status: string } | null`. Récupérer l'`id` (`useParams`). Au-dessus/dans le bloc Signataires, si `c.mySignature && ['SENT','VIEWED'].includes(c.mySignature.status)` :
```tsx
<a href={`/v1/portal/contracts/${id}/sign`} className="inline-block rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">
  Signer le document
</a>
```
(un `<a>` natif : la navigation navigateur suit le 302 serveur vers DocuSeal.)

- [ ] **Step 4 : page signature-complete + route**

```tsx
// apps/web/src/portal/portal-signature-complete-page.tsx
import { Link } from 'react-router-dom';
export function PortalSignatureCompletePage() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Merci</h1>
      <p className="mt-2 text-gray-600">Votre signature a bien été enregistrée.</p>
      <Link to="/portal/contracts" className="mt-4 inline-block text-lsi hover:underline">Revenir à mes contrats</Link>
    </div>
  );
}
```
Dans `portal-app.tsx`, ajouter la route **hors** du `PortalLayout` (accessible sans session, le client arrive depuis DocuSeal) — à côté de `login` :
```tsx
      <Route path="signature-complete" element={<PortalSignatureCompletePage />} />
```

- [ ] **Step 5 : lancer** — `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis racine `pnpm lint` — vert.

- [ ] **Step 6 : Commit** — `git add apps/web/src && git commit -m "feat(web): portail — bouton Signer (redirect DocuSeal) + page signature-complete"`

---

## Clôture

- [ ] Suites : `apps/api`, `@lsi/web` — vertes. CI locale verte.
- [ ] Merge `main` → CI → redéploiement. **Aucune migration, aucun nouveau secret** (DOCUSEAL_SIGN_URL déduit).
- [ ] Validation prod : avec le contact client de test + un contrat en signature, ouvrir la fiche portail → **Signer** → signer sur DocuSeal → retour sur `signature-complete`.
