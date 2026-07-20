# Phase E — Renouvellements (§6.12)

**Date** : 2026-07-20
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : initier le **renouvellement** d'un contrat en cours/expiré — créer un
**contrat successeur** pré-rempli lié au parent, suivi par une `RenewalRequest`
(acceptation à la signature, refus explicite). Les **avenants** (§6.12) sont un
increment séparé.

## 1. Objectif et constat

Le second trou du cycle de vie : on ne peut pas **renouveler** un contrat. Le
socle est pourtant complet :
- **Domaine** : `MARK_RENEWED`, statut `RENEWED`, et `EXPIRE → RENEWED` si le
  successeur est **signé**.
- **Schéma** : `Contract.predecessorContractId` / `successorContractId` (liens
  bidirectionnels) ; table **`RenewalRequest`** (`RenewalStatus` = PENDING /
  ACCEPTED / REFUSED / EXPIRED ; `contractId` = parent, `newContractId` =
  successeur, `initiatedByUserId/At`, `decidedAt`, `refusalReason`).
- **Lifecycle** : `lifecycle.service` fait `EXPIRE → RENEWED` en chargeant le
  successeur et en vérifiant `!!successor.signedAt` (RM-16, EC-08).

Ce qui **manque** : initier le renouvellement (créer le successeur + la
`RenewalRequest` + les liens), refuser, marquer accepté à la signature, et
l'UI. **Aucune migration.**

## 2. Décisions

| Sujet | Décision |
|---|---|
| Initier | `POST /v1/contracts/:id/renew` *(MSP_ADMIN, ACCOUNT_MANAGER)*. Parent **ACTIVE ou EXPIRED** (garde domaine `assertCanRenew`). **Un seul** renouvellement en cours par parent (pas de `RenewalRequest` PENDING existante). |
| Successeur | Nouveau contrat `type=MAIN`, DRAFT, **pré-rempli** depuis le parent, `predecessorContractId` = parent ; le parent reçoit `successorContractId`. |
| Suivi | `RenewalRequest` PENDING créée (`newContractId` = successeur). **ACCEPTED** automatique à la signature du successeur (hook webhook). **REFUSED** via action explicite. |
| Parent → RENEWED | **Rien à coder** : le sweep de cycle de vie le fait à la date de fin si le successeur est signé (RM-16, RM-21 pas de tacite, EC-08 refus n'prolonge rien). |
| Refus (EC-08) | `POST /v1/contracts/:id/renew/refuse` → `RenewalRequest` REFUSED (+ motif) ; on **délie** `parent.successorContractId` → le parent expire normalement. |

## 3. Domaine

`packages/domain/src/contract/state-machine.ts` — ajouter, sur le modèle de
`assertCanAmend`, un garde pur :
```ts
export function assertCanRenew(parent: ContractSnapshot): void {
  if (parent.status !== 'ACTIVE' && parent.status !== 'EXPIRED') {
    throw new BusinessRuleError(
      `Un renouvellement ne peut porter que sur un contrat actif ou expiré (statut actuel : ${parent.status}).`,
      'RM-16',
    );
  }
}
```
Exporté via le barrel. Test domaine : ACTIVE/EXPIRED → OK ; DRAFT/SIGNED/… →
`BusinessRuleError`. (Pas de nouvel événement : la création d'un successeur
n'est pas une transition du parent.)

## 4. API (`apps/api/src/contracts/`)

### 4.1 `POST /v1/contracts/:id/renew`
Service `renew(scope, id, session, now)` (une transaction `withScope`) :
1. Charger le parent (404 hors scope). `assertCanRenew(snapshot)` → 409 (RM-16) sinon.
2. Refuser s'il existe déjà une `RenewalRequest` PENDING pour ce parent → 409 (`RENEWAL_ALREADY_IN_PROGRESS`).
3. Créer le **successeur** : `type=MAIN`, `status=DRAFT`, `reference = nextReference(...)`, `title = parent.title + ' (renouvellement)'`, `customerId`/`category`/`amountCents`/`currency`/`billingFrequency`/`noticePeriodDays` copiés du parent, `predecessorContractId = parent.id`, `ownerUserId = session.userId` ; dates :
   - `startDate = parent.endDate ? parent.endDate + 1 jour : now`,
   - `endDate = (parent.startDate && parent.endDate) ? startDate + (parent.endDate − parent.startDate) : null`.
4. `parent.update({ successorContractId: successeur.id })`.
5. Créer la `RenewalRequest` : `contractId = parent`, `newContractId = successeur`, `status = PENDING`, `initiatedByUserId = session.userId`, `initiatedAt = now`.
6. Réponse `{ id: successeur.id, reference: successeur.reference }`.

### 4.2 `POST /v1/contracts/:id/renew/refuse` *(mêmes rôles)*
Corps `{ reason }` (obligatoire). Trouver la `RenewalRequest` PENDING du parent
(409 si aucune). La passer **REFUSED** (`refusalReason`, `decidedAt`). Délier
`parent.successorContractId = null`. Réponse `{ status: 'REFUSED' }`.

### 4.3 Acceptation automatique (hook)
Dans `docuseal-webhook.service` (chemin `FORM_COMPLETED` où le contrat passe
`SIGNED` quand tous ont signé) : après le passage à SIGNED, si le contrat porte
un `predecessorContractId`, passer sa `RenewalRequest` PENDING
(`newContractId = ce contrat`) à **ACCEPTED** (`decidedAt`). Idempotent (ne
touche que les PENDING).

### 4.4 `findOne` — exposer les liens
Ajouter à la réponse `findOne` (additif) :
- `renewal` : la dernière `RenewalRequest` du contrat (statut, `newContractId`,
  + `reference`/`status` du successeur) si elle existe ;
- `predecessor` : `{ id, reference }` si `predecessorContractId` non nul.

## 5. Frontend (fiche contrat)

Composant `<RenewContract>` :
- **Parent ACTIVE/EXPIRED, rôle MSP_ADMIN/ACCOUNT_MANAGER, aucune RenewalRequest active** → bouton **[Renouveler]** → `POST /renew` → **redirige vers le successeur** (`/contracts/<newId>`), qui suit le cycle normal.
- **Renouvellement en cours/décidé** → bandeau « Renouvellement → `<réf successeur>` (`statut`) », lien vers le successeur ; si PENDING et rôle : action **[Refuser]** (confirmation + motif) → `POST /renew/refuse` → invalide `['contract', id]`.
- **Ce contrat est un successeur** (`predecessor`) → bandeau « Renouvellement de `<réf prédécesseur>` » (lien).
- Erreurs API (409) inline.

Intégré à `contract-detail-page.tsx`, près des autres actions de cycle de vie.

## 6. Sécurité et tests

- **API** : scopée (404 hors scope, IDOR contrat de B → 404) ; rôle (403) ;
  renouveler un DRAFT → 409 (RM-16) ; double renouvellement → 409 ; le
  successeur est bien `type=MAIN` DRAFT lié (`predecessorContractId`), le parent
  `successorContractId` posé, la `RenewalRequest` PENDING créée ; refuser →
  REFUSED + délie le parent ; **auto-ACCEPTED** : à la signature du successeur,
  la `RenewalRequest` passe ACCEPTED (test via le webhook / la transition
  SIGNED). Pré-remplissage des dates vérifié (début = fin parent + 1 j).
- **Domaine** : `assertCanRenew` (ACTIVE/EXPIRED OK ; autres → BusinessRuleError).
- **Front** : bouton Renouveler visible selon statut + rôle + absence de
  renouvellement actif ; bandeaux de liaison ; Refuser (confirmation + motif) ;
  POST des bons endpoints ; redirection vers le successeur.

## 7. Non-objectifs (différés)

- **Avenants** (§6.12, `type=AMENDMENT`, report des champs à la signature RM-18,
  EC-12) — increment séparé.
- Écran transverse « contrats à renouveler » (le tableau de bord/rappels J-90
  couvre déjà l'alerte).
- Demande de renouvellement initiée par le **client** (portail).
- Régénération des rappels sur le successeur au-delà du socle existant.
