# Phase E — Envoi en signature (§6.7) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Envoyer un contrat approuvé en signature DocuSeal en utilisant les signataires DÉJÀ définis sur le contrat, avec une confirmation front avant l'envoi réel.

**Architecture:** Refonte de `send-for-signature.service` pour lire les `ContractSigner` du contrat au lieu de `dto.signers` (plus de suppression/recréation). Le front ajoute une action « Envoyer en signature » (sur un contrat APPROVED, gardée par `allowed-actions` + rôle) avec confirmation + `Idempotency-Key`.

**Tech Stack:** NestJS 10, Prisma 5, React 18, TanStack Query 5, Vitest + Testing Library + supertest + Testcontainers ; DocuSeal (fake en test), Gotenberg (fake en test), stockage in-memory en test.

## Global Constraints

- **Monorepo pnpm** ; front = `@lsi/web`. Node 22, pnpm 9.15.9. Runtime API en **SWC** (jamais tsx).
- **Sécurité** : endpoints scopés par le `ScopeGuard` global. **404 (jamais 403) hors scope** ; **403** rôle insuffisant ; **422** règle métier (RM-12 signataires) ; **409** demande déjà en cours / transition invalide ; **502** provider indisponible (contrat inchangé, EC-04). Data via `withScope`. `Idempotency-Key` **obligatoire** sur l'envoi (§11.8), réponse **202**.
- **UI en français.** Le front ne porte AUCUNE autorisation.
- **CI** (`lint`+`typecheck`+`test`) verte. Interdit `$queryRawUnsafe`/`$executeRawUnsafe` hors testing.
- **Pattern de test API** : `SessionService.put(...)` + en-tête `x-lsi-session`. Renderer/provider/stockage en test : `FakeRenderer`, `FakeProvider` (de `apps/api/tests/support/fakes.js`), `InMemoryStorage`, fournis via `.overrideProvider(...)`.
- **Aucune migration.**

---

## Structure de fichiers

**API**
- Modify: `apps/api/src/signature/send-for-signature.service.ts` (utiliser les signataires du contrat)
- Modify: `apps/api/src/contracts/dto/send-for-signature.dto.ts` (retirer `signers`)
- Modify: `apps/api/tests/isolation/send-for-signature.test.ts` (semer des signataires ; retirer `signers` du corps)

**Front (`apps/web`)**
- Modify: `apps/web/src/lib/api.ts` (`apiPost` accepte un en-tête optionnel)
- Create: `apps/web/src/features/contracts/send-for-signature.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (intégrer)

---

## Task 1 : API — l'envoi utilise les signataires du contrat

**Files:**
- Modify: `apps/api/src/signature/send-for-signature.service.ts`
- Modify: `apps/api/src/contracts/dto/send-for-signature.dto.ts`
- Modify: `apps/api/tests/isolation/send-for-signature.test.ts`

**Interfaces:**
- Produces: `send()` lit les `ContractSigner` du contrat (ordre `signingOrder`), valide RM-12 depuis eux, et construit submission + bloc PDF depuis eux. `SendForSignatureDto` n'a plus `signers` (garde `expireInDays?`, `subject?`, `body?`). Comportement externe inchangé (202, idempotence, EC-04, contrat → PENDING_SIGNATURE).

- [ ] **Step 1 : Adapter le test (RED)**

Dans `apps/api/tests/isolation/send-for-signature.test.ts` :

1. `seedApprovedContract` accepte un jeu de signataires et les sème. Ajouter un
   paramètre `signers` et, dans le `withScope`, après la création de la version :

```typescript
async function seedApprovedContract(
  over: Record<string, unknown> = {},
  signers: { party: 'LSI' | 'CLIENT'; fullName: string; email: string; signingOrder: number }[] = [
    { party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.fr', signingOrder: 0 },
    { party: 'CLIENT', fullName: 'J. Dupont', email: 'j.dupont@dupont.fr', signingOrder: 1 },
  ],
) {
  // … création contract + version inchangée …
  // (dans le même withScope, après contractVersion.create)
  if (signers.length) {
    await tx.contractSigner.createMany({
      data: signers.map((s) => ({
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id,
        party: s.party, fullName: s.fullName, email: s.email, signingOrder: s.signingOrder,
        status: 'PENDING', createdAt: now, updatedAt: now,
      })),
    });
  }
  return { id, versionId: vId };
}
```

2. Le corps envoyé n'a plus `signers` :

```typescript
const body = () => ({}); // défauts serveur ; ni signers, ni options
```

3. Les tests qui variaient les signataires (RM-12 « il manque le LSI/le client »)
   sèment désormais un jeu incomplet **au seed** au lieu de le passer dans le corps.
   Exemple pour « pas de signataire client → 422 » :

```typescript
test('sans signataire client → 422 (RM-12)', async () => {
  const { id } = await seedApprovedContract({}, [
    { party: 'LSI', fullName: 'Marc', email: 'lsi@lsi.fr', signingOrder: 0 },
  ]);
  await send(id).expect(422);
});
```

4. Parcourir les autres tests du fichier : partout où le corps portait
   `signers` (via `body({ signers: … })` ou un littéral), retirer `signers` et,
   si le test dépendait d'un jeu de signataires particulier, le passer au
   **seed**. Les assertions sur `renderer.lastHtml` (balises `{{Signature;role=…}}`)
   et sur les submitters restent valables (2 signataires semés par défaut).

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/send-for-signature.test.ts`
Expected: FAIL (le service lit encore `dto.signers`, désormais absent → `hasLsi`/`hasClient` sur `undefined`, ou 422/erreur).

- [ ] **Step 3 : Refondre le service**

Dans `send-for-signature.service.ts`, méthode `send`, tx1 (`prepared`) :

a) Charger les signataires du contrat juste après le chargement du contrat, et
valider RM-12 depuis eux — remplacer :
```typescript
      const hasLsi = dto.signers.some((s) => s.party === 'LSI');
      const hasClient = dto.signers.some((s) => s.party === 'CLIENT');
```
par :
```typescript
      // Les signataires sont DÉFINIS sur le contrat (bloc Signataires) — on les
      // lit, on ne les redemande plus. Ordre = signingOrder (RM-13).
      const signers = await tx.contractSigner.findMany({
        where: { contractId },
        orderBy: { signingOrder: 'asc' },
      });
      const hasLsi = signers.some((s) => s.party === 'LSI');
      const hasClient = signers.some((s) => s.party === 'CLIENT');
```

b) Supprimer entièrement le bloc de suppression/recréation :
```typescript
      // À SUPPRIMER :
      await tx.contractSigner.deleteMany({ where: { contractId, status: 'PENDING' } });
      const signers = await Promise.all(
        dto.signers.map((s) => tx.contractSigner.create({ /* … */ })),
      );
```
(`signers` est désormais la liste chargée en (a) ; ne pas le redéclarer.)

c) Le `return { contract, version, signers, sigReq };` reste — `signers` pointe
maintenant les lignes existantes.

Dans la partie I/O (hors tx) :

d) Bloc de signature depuis les signataires chargés :
```typescript
      const withSignatureBlock = version.bodyHtml + this.buildSignatureBlock(signers);
```

e) Mapping des submitters depuis `signers` (chaque `s` EST la ligne, plus de
lookup par email ; 2FA par défaut) :
```typescript
    const submitters: SubmitterCommand[] = [...signers]
      .sort((a, b) => a.signingOrder - b.signingOrder)
      .map((s) => ({
        party: s.party,
        roleLabel: this.roleLabel(s.party),
        externalId: s.id, // clé de rapprochement des webhooks (§11.5)
        fullName: s.fullName,
        email: s.email,
        signingOrder: s.signingOrder,
        requireEmail2fa: s.party === 'CLIENT', // défaut : 2FA côté client
        fields: [],
      }));
```

f) Ajuster les signatures de `buildSignatureBlock` et le type `SubmitterCommand`
si elles étaient typées `SignerDto` : `buildSignatureBlock` prend désormais des
lignes `ContractSigner` (il n'utilise que `party` via `roleLabel`). Le reste
(rendu, stockage, `createSubmission`, gestion d'échec EC-04, tx2 de succès qui
met les signataires en SENT par `externalId = s.id`, contrat →
PENDING_SIGNATURE) est **inchangé**.

Dans `send-for-signature.dto.ts` : retirer le champ `signers` (et ses
décorateurs). Garder `expireInDays?`, `subject?`, `body?`. Si `SignerDto` n'est
plus référencé nulle part, le supprimer ; sinon le garder.

- [ ] **Step 4 : Lancer, vérifier le succès + non-régression**

Run: `cd apps/api && pnpm exec vitest run tests/isolation/send-for-signature.test.ts && pnpm exec vitest run`
Expected: PASS (le fichier d'envoi adapté + toute la suite isolation). `pnpm --filter @lsi/api exec tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/signature/send-for-signature.service.ts apps/api/src/contracts/dto/send-for-signature.dto.ts apps/api/tests/isolation/send-for-signature.test.ts
git commit -m "feat(api): l'envoi en signature utilise les signataires définis sur le contrat"
```

---

## Task 2 : Front — action « Envoyer en signature » (confirmation + Idempotency-Key)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`apiPost` accepte un en-tête optionnel)
- Create: `apps/web/src/features/contracts/send-for-signature.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`
- Test: `apps/web/src/test/send-for-signature.test.tsx`

**Interfaces:**
- Consumes: `apiPost(path, body, opts?)`, `useMutation`, `useMe`. `findOne().signers` (racine, `{ id, party, fullName, email, signingOrder }`), `allowed-actions` (contient `SEND_FOR_SIGNATURE` quand APPROVED cohérent).
- Produces: `<SendForSignature contractId signers allowedActions roles />` — bouton (si `SEND_FOR_SIGNATURE` + rôle AM/admin) → confirmation → POST avec `Idempotency-Key`.

- [ ] **Step 1 : Écrire le test qui échoue**

```tsx
// apps/web/src/test/send-for-signature.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SendForSignature } from '../features/contracts/send-for-signature.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const signers = [
  { id: 's1', party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0 },
  { id: 's2', party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1 },
];

test('confirme et envoie avec un Idempotency-Key', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/send-for-signature');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    return new Response(JSON.stringify({ signatureRequestId: 'r1', status: 'SENT' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  vi.stubGlobal('crypto', { randomUUID: () => 'idem-123' } as never);

  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Envoyer en signature/ }));
  // le panneau de confirmation liste les signataires
  expect(screen.getByText(/Jean/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Confirmer l’envoi/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('sans SEND_FOR_SIGNATURE dans allowed-actions, pas de bouton', () => {
  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['CANCEL']} roles={['MSP_ADMIN']} />);
  expect(screen.queryByRole('button', { name: /Envoyer en signature/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `pnpm --filter @lsi/web test src/test/send-for-signature.test.tsx`
Expected: FAIL (module absent).

- [ ] **Step 3 : `apiPost` avec en-tête optionnel + composant**

Dans `apps/web/src/lib/api.ts`, ajouter un 3e paramètre optionnel à `apiPost` :
```typescript
export async function apiPost<T>(
  path: string,
  body: unknown,
  opts?: { headers?: Record<string, string> },
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts?.headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
    } catch { /* corps non-JSON */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
```
(Rétrocompatible : les appels existants à deux arguments restent valides.)

```tsx
// apps/web/src/features/contracts/send-for-signature.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { partyLabel } from '../../lib/labels.js';

interface Signer { id: string; party: string; fullName: string; email: string; signingOrder: number; }

export function SendForSignature({
  contractId, signers, allowedActions, roles,
}: {
  contractId: string; signers: Signer[]; allowedActions: string[]; roles: string[];
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const send = useMutation({
    mutationFn: () =>
      apiPost(`/v1/contracts/${contractId}/send-for-signature`, {}, {
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setConfirming(false);
    },
  });

  const canSend =
    allowedActions.includes('SEND_FOR_SIGNATURE') &&
    roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  if (!canSend) return null;

  const error = send.error instanceof ApiError ? send.error.message : send.error ? 'Erreur.' : undefined;
  const sorted = [...signers].sort((a, b) => a.signingOrder - b.signingOrder);

  return (
    <div className="space-y-2">
      {!confirming ? (
        <button type="button" className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark" onClick={() => setConfirming(true)}>
          Envoyer en signature
        </button>
      ) : (
        <div className="space-y-3 rounded border p-3">
          <p className="text-sm font-medium">Confirmer l’envoi en signature</p>
          <p className="text-sm text-gray-600">Des emails de signature vont être envoyés à ces personnes, dans l’ordre :</p>
          <ul className="text-sm">
            {sorted.map((s) => (
              <li key={s.id}>{s.signingOrder + 1}. {s.fullName} <span className="text-gray-400">({partyLabel(s.party)})</span> — {s.email}</li>
            ))}
          </ul>
          <a href={`/v1/contracts/${contractId}/preview.pdf`} target="_blank" rel="noopener" className="text-sm text-lsi hover:underline">Aperçu PDF</a>
          <div className="flex gap-2">
            <button type="button" disabled={send.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50" onClick={() => send.mutate()}>
              {send.isPending ? 'Envoi…' : 'Confirmer l’envoi'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setConfirming(false)}>Annuler</button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : Intégrer dans la fiche**

Dans `contract-detail-page.tsx` : `<SendForSignature contractId={contract.id} signers={q.data.signers} allowedActions={allowed.data?.allowedActions ?? []} roles={me.data?.roles ?? []} />`, à côté de `<WorkflowActions>` (le contrat est APPROVED à ce stade — le composant se masque sinon). `allowed` (`['allowed-actions', id]`) et `me` sont déjà chargés dans la fiche (Task 7 de l'incrément workflow).

- [ ] **Step 5 : Lancer, vérifier le succès + suites**

Run: `pnpm --filter @lsi/web test && pnpm --filter @lsi/web typecheck` puis, depuis la racine, `pnpm lint`
Expected: PASS + clean.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/src
git commit -m "feat(web): action Envoyer en signature (confirmation + Idempotency-Key)"
```

---

## Clôture

- [ ] **Suites** : `cd apps/api && pnpm exec vitest run` ; `pnpm --filter @lsi/web test` — vert.
- [ ] **CI locale** : `pnpm lint && pnpm typecheck && pnpm test` — vert.
- [ ] **Déploiement** : merger sur `main` → CI → redéployer (préserver l'env live, relogin Portainer si besoin). **Aucune migration.** ⚠️ DocuSeal réel : pour valider, créer un contrat de test, l'approuver (avec le relecteur), définir un signataire client à une **adresse de test**, puis « Envoyer en signature » et vérifier la réception de l'email + la progression sur la fiche.
