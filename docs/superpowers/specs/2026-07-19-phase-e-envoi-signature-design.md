# Phase E — Envoi en signature (§6.7)

**Date** : 2026-07-19
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : transformer un contrat **approuvé** en demande de signature DocuSeal,
en utilisant les **signataires déjà définis** sur le contrat, avec une
confirmation avant l'envoi réel, et l'affichage de la progression (déjà en
place).

## 1. Objectif et constat

L'endpoint `POST /v1/contracts/:id/send-for-signature` existe et fonctionne
(rendu PDF Gotenberg → submission DocuSeal → `signature_request` + signataires
en SENT → contrat en `PENDING_SIGNATURE`, après acquittement du provider,
EC-04). Mais il prend les signataires **en ligne** (`dto.signers`) et
**supprime/recrée** les signataires PENDING — un vestige d'avant l'incrément
workflow, où les signataires n'existaient pas encore.

Depuis l'incrément workflow, les signataires sont **définis sur le contrat**
(bloc « Signataires », RM-12 vérifié à la soumission). L'envoi doit donc
**utiliser ces signataires**, pas les redemander. Il ne reste alors, côté
front, qu'à déclencher l'envoi avec une confirmation.

Non-objectifs (différés) : relances / révocation depuis l'UI (§6.8),
personnalisation avancée du message d'invitation, renouvellements/avenants.

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Source des signataires | L'envoi lit les **`ContractSigner` du contrat** (ordre `signingOrder`, RM-13), plus `dto.signers`. RM-12 (≥1 LSI + ≥1 client) vérifié depuis eux → **422** sinon. |
| Suppression/recréation | **Supprimée.** Les signataires existent ; l'envoi les passe en `SENT` (avec `providerSubmitterId`/slug) après acquittement du provider, comme aujourd'hui — sur les **mêmes** lignes (`externalId = signer.id`, clé de rapprochement des webhooks §11.5). |
| 2FA email | Défaut `requireEmail2fa = (party === 'CLIENT')` (le modèle `ContractSigner` n'a pas de champ 2FA ; défaut historique conservé). |
| DTO | On retire `signers` de `SendForSignatureDto` ; on garde `expireInDays?`, `subject?`, `body?` (optionnels, défauts serveur). `Idempotency-Key` reste **obligatoire** (anti-double-envoi §11.8), réponse **202**. |
| État requis | Le domaine `SEND_FOR_SIGNATURE` valide déjà (APPROVED + `approvedVersionId === currentVersionId`) ; `allowed-actions` ne propose l'envoi que dans ce cas. Rien à changer côté domaine. |
| Confirmation | L'envoi émet de **vrais emails** : le front demande une **confirmation** (revue des signataires + aperçu) avant de POSTer. |

## 3. Changement d'API (`apps/api/src/signature/send-for-signature.service.ts`)

Refonte de `send()` :
1. Charger les signataires du contrat : `const signers = await tx.contractSigner.findMany({ where: { contractId }, orderBy: { signingOrder: 'asc' } })`.
2. RM-12 depuis `signers` (au lieu de `dto.signers`) → 422 si pas de LSI **ou** pas de client.
3. **Supprimer** le bloc `deleteMany({ status:'PENDING' })` + `create(...)` : les
   signataires existent déjà, on les utilise tels quels.
4. `buildSignatureBlock(signers)` et le mapping `submitters` depuis `signers`
   (`externalId = signer.id`, `requireEmail2fa = signer.party === 'CLIENT'`,
   `roleLabel = roleLabel(signer.party)`).
5. Le reste inchangé : rendu PDF, stockage + hash, `createSubmission`, gestion
   d'échec (EC-04 : le contrat ne bouge pas), tx2 de succès (signature_request →
   SENT, signataires → SENT + `providerSubmitterId`, contrat →
   `PENDING_SIGNATURE`).
6. `SendForSignatureDto` : retirer `signers` (et `SignerDto` s'il n'est plus
   utilisé) ; garder `expireInDays?`, `subject?`, `body?`. Le contrôleur et
   l'en-tête `Idempotency-Key` restent inchangés.

Note : le test `send-for-signature.test.ts` existant passe `dto.signers` — il
faudra **semer des `ContractSigner`** sur le contrat et retirer `signers` du
corps envoyé.

## 4. Frontend (fiche contrat)

- Sur un contrat **APPROVED** (si `allowed-actions` contient
  `SEND_FOR_SIGNATURE` **et** rôle MSP_ADMIN/ACCOUNT_MANAGER) : un composant
  `<SendForSignature>` affiche **[Envoyer en signature]**.
- Au clic → **panneau de confirmation** : liste des signataires (nom, partie,
  email, ordre) tirée de `findOne().signers`, lien **[Aperçu PDF]**, et un
  avertissement « des emails de signature vont être envoyés ». Boutons
  **[Confirmer l'envoi]** / **[Annuler]**.
- Confirmation → génère un `Idempotency-Key` (`crypto.randomUUID()`), POST
  `send-for-signature` avec l'en-tête, corps vide `{}` (défauts serveur) → **202**
  → « Demande envoyée », invalide `['contract', id]` + `['allowed-actions', id]`.
  Le **bloc Signature** existant affiche ensuite la progression par signataire.
- Erreurs API (422 signataires incomplets, 409 déjà en cours, 502 provisoire
  provider) affichées inline.

`apiPost` doit permettre d'ajouter l'en-tête `Idempotency-Key` : soit une
variante `apiPost(path, body, { headers })`, soit un petit `apiSend` dédié.

## 5. Sécurité et tests

- **API** : envoi via les signataires du contrat ; RM-12 depuis eux (422) ;
  idempotence (même clé → même `signature_request`, aucun second envoi) ; garde
  domaine (envoi refusé si pas APPROVED cohérent → 409) ; échec provider →
  `signature_request` FAILED, contrat inchangé (EC-04) ; IDOR (contrat de B →
  404). Tests via `FakeProvider` + `FakeRenderer` + `InMemoryStorage`
  (override des tokens), en **semant des `ContractSigner`** sur le contrat.
- **Front** : le bouton n'apparaît que si `allowed-actions` le permet + rôle ;
  la confirmation liste les signataires ; le POST porte l'`Idempotency-Key` ;
  le résultat 202 affiche « Demande envoyée » et invalide les requêtes.

## 6. Déploiement

**Aucune migration.** DocuSeal est réel en prod : un envoi **envoie de vrais
emails** au signataire (§11.7). La validation prod se fera avec une **adresse de
test** (comme lors des tests DocuSeal précédents), pas un vrai client. Même
image, même stack ; Gotenberg et DocuSeal déjà en place.
