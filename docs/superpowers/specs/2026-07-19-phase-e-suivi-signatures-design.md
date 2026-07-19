# Phase E — Suivi des signatures : actions (§6.8)

**Date** : 2026-07-19
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : ajouter les **actions** de suivi de signature — **relancer** les
signataires en cours et **révoquer** une demande — sur la fiche contrat. La
progression par signataire et le téléchargement du signé existent déjà.

## 1. Objectif et constat

Après un envoi en signature, la fiche affiche déjà la progression (SENT / VIEWED
/ SIGNED / DECLINED, piloté par le webhook) et un bouton « Télécharger le
signé ». Il manque les actions du §6.8 :

- **Relancer** : renvoyer l'email d'invitation aux signataires en cours.
- **Révoquer** : annuler la demande de signature (chez DocuSeal) pour corriger
  puis renvoyer, **sans annuler le contrat** (distinct de §6.13).

Les deux mécanismes DocuSeal sont confirmés : relance =
`PUT /submitters/{id} {send_email:true}` ; révocation =
`DELETE /submissions/{id}` (archive).

Non-objectifs (différés) : l'écran transverse `/signatures` (toutes les
signatures en cours), la relance ciblée d'un seul signataire.

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Sémantique de révocation | **`REVOKE_SIGNATURE`** ramène le contrat de `PENDING_SIGNATURE`/`PARTIALLY_SIGNED` à **`APPROVED`** (envoyable de nouveau ; `approvedVersionId` conservé). Ce n'est **pas** annuler le contrat. |
| État après révocation | `signature_request` → **REVOKED** ; signataires remis à **PENDING** avec `providerSubmitterId`/slug effacés (une nouvelle submission repartira propre). |
| Relance | Renvoie l'email aux signataires **en cours** (statut SENT ou VIEWED) de la demande active, chacun via son `providerSubmitterId`. Ne modifie aucun état local. |
| Ordre des opérations | Comme l'envoi (EC-04) : l'appel DocuSeal (I/O) se fait **hors transaction** ; on ne persiste l'effet (REVOKED, contrat APPROVED) qu'**après** succès du provider. Échec provider → **502**, rien ne bouge. |
| Autorisation | `assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`. **404** hors scope, **403** rôle, **409** s'il n'y a pas de demande active. |

## 3. Provider (port + adaptateur + fakes)

`packages/domain/src/signature/e-signature-provider.port.ts` — ajouter au port
`ESignatureProvider` :
```ts
remindSubmitter(providerSubmitterId: string): Promise<void>;
revokeSubmission(providerSubmissionId: string): Promise<void>;
```
`apps/api/src/signature/docuseal.adapter.ts` :
- `remindSubmitter` → `PUT {baseUrl}/submitters/{id}` avec `X-Auth-Token` et
  corps `{ send_email: true }`.
- `revokeSubmission` → `DELETE {baseUrl}/submissions/{id}` avec `X-Auth-Token`.
- Erreurs réseau/HTTP → `ProviderError(message, retryable)` (comme
  `createSubmission`).

`apps/api/tests/support/fakes.ts` — `FakeProvider` : implémenter les deux
méthodes en **enregistrant** les appels (`reminded: string[]`,
`revoked: string[]`), pour les assertions de test ; respecter `failNext`.

## 4. Domaine

`packages/domain/src/contract/{contract.types.ts, state-machine.ts}` :
- `ContractEvent` : ajouter `| { type: 'REVOKE_SIGNATURE'; actorUserId: string }`.
- `TRANSITIONS` : ajouter `'REVOKE_SIGNATURE'` à `PENDING_SIGNATURE` et
  `PARTIALLY_SIGNED`.
- `applyEvent`, cas `REVOKE_SIGNATURE` : `return { ...c, status: 'APPROVED' }`
  (l'`approvedVersionId` reste posé → renvoi possible sans revalidation).
- `allowedEvents` : `REVOKE_SIGNATURE` → autorisé (pas de garde supplémentaire).
- Tests domaine : depuis PENDING_SIGNATURE/PARTIALLY_SIGNED, `REVOKE_SIGNATURE`
  → APPROVED ; depuis un autre statut → transition invalide.

## 5. API (`apps/api/src/signature/`)

Un `SignatureActionsService` + routes sur `@Controller('v1/contracts')`.

### 5.1 `POST /v1/contracts/:id/signature/remind` *(MSP_ADMIN, ACCOUNT_MANAGER)*
- Charge la demande active (statut ∈ {SENT, PARTIALLY_COMPLETED}) sous
  `withScope` ; 404 si le contrat est hors scope ; **409** s'il n'y a pas de
  demande active.
- Charge les signataires en cours (statut SENT ou VIEWED) avec
  `providerSubmitterId` non nul ; pour chacun, `provider.remindSubmitter(id)`.
- Renvoie `{ reminded: <nombre> }`. Échec provider → 502.

### 5.2 `POST /v1/contracts/:id/signature/revoke` *(MSP_ADMIN, ACCOUNT_MANAGER)*
- Charge la demande active + le contrat sous `withScope` ; 404 hors scope ;
  **409** sans demande active.
- Valide la transition via le domaine (`REVOKE_SIGNATURE`) — 409 si le contrat
  n'est pas dans un état révocable.
- `provider.revokeSubmission(providerSubmissionId)` (I/O) ; échec → 502.
- Puis, en transaction : `signature_request` → REVOKED ; signataires →
  PENDING (+ `providerSubmitterId`/slug à null) ; contrat → APPROVED (domaine).
- Renvoie `{ status: 'REVOKED' }`.

Toutes deux scopées, gardées par rôle, testées IDOR (contrat de B → 404).

## 6. Frontend (bloc Signature de la fiche)

- Quand le contrat est `PENDING_SIGNATURE`/`PARTIALLY_SIGNED` (une demande de
  signature existe), afficher dans/à côté du bloc Signature (si rôle
  MSP_ADMIN/ACCOUNT_MANAGER) :
  - **[Relancer]** → `POST …/signature/remind` → « Relance envoyée ».
  - **[Révoquer]** → **confirmation** (« la demande sera annulée, le contrat
    redeviendra approuvé ») → `POST …/signature/revoke` → invalide
    `['contract', id]` + `['allowed-actions', id]`.
- Erreurs API (409, 502) inline. La progression par signataire et
  « Télécharger le signé » restent inchangées.

L'affichage des boutons peut se piloter par le **statut** du contrat
(`PENDING_SIGNATURE`/`PARTIALLY_SIGNED`) + rôle ; l'API reste le garde-fou.

## 7. Sécurité, tests, déploiement

- **Sécurité** : actions scopées + gardées par rôle ; ordre EC-04 (provider
  avant persistance) ; le front ne porte aucune autorisation.
- **Tests API** : via `FakeProvider` (relance/révocation enregistrées) —
  relance appelle le provider pour chaque signataire en cours et renvoie le
  compte ; 409 sans demande active ; révocation appelle le provider, met la
  demande en REVOKED, le contrat en APPROVED, les signataires en PENDING ;
  échec provider → 502, rien ne bouge ; IDOR (contrat de B → 404).
- **Tests domaine** : `REVOKE_SIGNATURE` (transition + allowedEvents).
- **Tests SPA** : boutons Relancer/Révoquer visibles selon le statut + rôle ;
  confirmation pour révoquer ; POST du bon endpoint.
- **Déploiement** : **aucune migration.** ⚠️ DocuSeal réel : révoquer archive une
  vraie submission ; relancer **renvoie un email**. Validation prod prudente
  (sur une submission de test).
