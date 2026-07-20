# Portail client — Signature in-portal (§6.15 / §11.7, increment 2)

**Date** : 2026-07-20
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : permettre au client connecté au portail de **signer** un contrat
en attente de sa signature — via une redirection serveur vers la page DocuSeal,
avec une page de remerciement au retour. Les actions client (renouvellement/
résiliation) restent un increment ultérieur.

## 1. Objectif et constat

La consultation (increment 1) est en place. La signature elle-même vit chez
**DocuSeal** : chaque signataire a un `providerSubmitterSlug` (stocké à l'envoi),
et sa page de signature est `${DOCUSEAL public}/s/{slug}`. Le
`completedRedirectUrl` pointe **déjà** sur `${PORTAL_URL}/portal/signature-complete`.
Aujourd'hui le client ne peut signer que via le lien reçu par email DocuSeal ;
cet increment amène l'entrée de signature **dans le portail** (pour un client
authentifié), sans réinventer de mécanisme de jeton.

`DOCUSEAL_URL = https://signe.lsi-maintenance.fr/api` → base publique de
signature = sans `/api` → `https://signe.lsi-maintenance.fr`.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Mécanisme | **Redirection serveur** vers DocuSeal `/s/{slug}` (pas d'embed `<docuseal-form>`). DocuSeal gère l'UI + la 2FA email du client. |
| Résolution du signataire | Le signataire **du client connecté** : `ContractSigner` du contrat, `party=CLIENT`, `email = email de la session` (unicité `(contractId, email)`). |
| Slug | **Jamais** exposé dans le JSON. Le detail expose seulement `mySignature: { status }` ; l'endpoint `/sign` fait la redirection serveur. |
| Éligibilité | Bouton/redirection seulement si le statut du signataire ∈ {SENT, VIEWED} (en attente). SIGNED → « déjà signé » ; sinon 409. |
| Config | `DOCUSEAL_SIGN_URL` (base publique DocuSeal). Défaut : `DOCUSEAL_URL` sans `/api`. |
| Retour | Page portail **`/portal/signature-complete`** (remerciement), accessible sans session (le client y arrive depuis DocuSeal). |

## 3. API (`apps/api/src/portal/`)

### 3.1 `GET /v1/portal/contracts/:id` — ajouter `mySignature`
Sur le detail portail existant, ajouter `mySignature: { status } | null` : le
statut du `ContractSigner` (party=CLIENT) dont l'email correspond à l'email de
la session (résolu via `emailOf`, déjà présent). `null` si le client n'est pas
signataire de ce contrat. **Pas le slug.**

### 3.2 `GET /v1/portal/contracts/:id/sign`
- Sous `withScope` (RLS → 404 hors scope). Résoudre le signataire du client
  (party=CLIENT, email de session). 404 s'il n'est pas signataire de ce contrat.
- Si le statut ∉ {SENT, VIEWED} **ou** `providerSubmitterSlug` absent → **409**
  (`NO_PENDING_SIGNATURE`) — rien à signer (déjà signé, pas encore envoyé…).
- Sinon **302** vers `${DOCUSEAL_SIGN_URL}/s/{providerSubmitterSlug}`.
- Le slug reste **côté serveur**. Endpoint sous `/v1/portal/*` (garde
  deny-by-default OK).

## 4. Frontend (`apps/web/src/portal/`)

- **Fiche portail** (`portal-contract-page.tsx`) : dans le bloc Signataires, si
  `mySignature.status ∈ {SENT, VIEWED}` → bouton **[Signer le document]** =
  lien vers `/v1/portal/contracts/:id/sign` (navigation navigateur → 302 vers
  DocuSeal). Si `SIGNED` → « Signé le … ». (Le bouton ne s'affiche que pour le
  signataire connecté, via `mySignature`.)
- **`/portal/signature-complete`** (nouvelle route dans la zone portail,
  accessible sans session) : message « Merci, votre signature a été
  enregistrée. » + lien « Revenir à mes contrats » (`/portal/contracts`).

## 5. Sécurité et tests

- **API** : `mySignature` ne révèle que le statut du signataire **du client**
  (jamais celui des autres) ; l'endpoint `/sign` ne redirige que vers le slug du
  **propre** signataire du client (match email) sur **son** contrat (RLS → 404
  sinon) ; 409 si pas de signature en attente (pas d'oracle) ; slug jamais dans
  le JSON. La signature (identité, 2FA) reste gérée par DocuSeal.
- **Tests API** : un signataire client SENT → `mySignature.status='SENT'` +
  `/sign` → 302 vers `…/s/{slug}` ; SIGNED → 409 ; contrat où le client n'est
  pas signataire → `mySignature=null` + `/sign` → 404 ; contrat d'un autre
  client (IDOR) → 404.
- **Front** : bouton Signer visible selon `mySignature.status` ; lien vers le
  bon endpoint ; page signature-complete rendue sans session.

## 6. Non-objectifs (increments suivants)

- **Actions client** (demander renouvellement / résiliation depuis le portail).
- Embed `<docuseal-form>` dans le portail (redirection suffit au MVP).
- Téléchargement du PDF signé depuis le portail.
- Relance/révocation côté client.
