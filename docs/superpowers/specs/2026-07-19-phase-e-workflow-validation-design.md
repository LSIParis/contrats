# Phase E — Workflow de validation interne (§6.6) + signataires

**Date** : 2026-07-19
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : rendre le workflow de validation réellement utilisable et correct —
définir les signataires d'un contrat, le soumettre, l'approuver / demander des
modifications / annuler, avec **RM-10 (soumetteur ≠ validateur) effectivement
appliqué** et **RM-11 (éditer un contrat approuvé le rouvre)**.

## 1. Objectif et constat

Les endpoints de transition existent (`/submit`, `/approve`, `/request-changes`,
`/cancel`) mais le workflow est un **théâtre** aujourd'hui :

- `applyEvent` **ne crée jamais** de `contract_approvals` → `submittedByUserId`
  n'est jamais enregistré → **RM-10 n'est pas appliqué** (n'importe qui approuve,
  y compris le soumetteur).
- La garde de soumission exige un signataire LSI + un client (RM-12), mais **rien
  ne permet de définir des signataires** sur un brouillon.
- `allowedActions` construit son snapshot avec `signers: []` → il ne reporte
  **jamais** « Soumettre ».
- Aucune UI de workflow (boutons, motifs).

Le prérequis manquant — le **contenu/versions** — existe désormais (incrément
éditeur). On peut donc bâtir le workflow correctement.

Non-objectifs (différés) : envoi en signature (assistant DocuSeal), résiliation
post-signature (§6.13), renouvellements/avenants (§6.12), file d'attente du
relecteur `/reviews`.

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Contenu requis pour soumettre | Règle ajoutée au **domaine** : `SUBMIT_FOR_REVIEW` exige `currentVersionId` (on ne relit pas du vide, RM-11). `allowedEvents` filtre « Soumettre » en conséquence. |
| Persistance des approbations | `applyEvent` (service) crée/résout les `contract_approvals` : `SUBMIT` → PENDING (versionId = currentVersionId, submittedByUserId) ; `APPROVE` → APPROVED ; `REQUEST_CHANGES` → CHANGES_REQUESTED (+ motif), avec `decidedByUserId`. RM-10 appliqué par le domaine **et** le CHECK base (`decided_by <> submitted_by`). |
| RM-11 (réouverture) | Éditer un contrat `APPROVED` le repasse en `DRAFT` (annule `approvedVersionId`). La garde d'éditabilité du contenu s'étend à `APPROVED` avec cet effet de bord. |
| Signataires | Définis sur un contrat éditable via `POST/DELETE …/signers`. Statut initial `PENDING`. Le rapprochement avec l'envoi en signature est différé. |
| `allowedActions` / `findOne` | `allowedActions` charge les **vrais** signataires. `findOne` renvoie les signataires au niveau racine + le **statut d'approbation** (soumetteur, décision, motif) pour piloter l'UI. |
| Autorisation | `assertRole` : soumettre/annuler = MSP_ADMIN/ACCOUNT_MANAGER ; approuver/demander modifs = MSP_ADMIN/LEGAL_REVIEWER. **403** rôle, **404** hors scope, **409** transition/règle métier invalide, **422** contenu manquant. |

## 3. Changements de domaine (`packages/domain`)

- `state-machine.ts`, cas `SUBMIT_FOR_REVIEW` : après les gardes existantes,
  ajouter `if (!c.currentVersionId) throw new BusinessRuleError('Le contrat doit avoir un contenu rédigé avant d'être soumis.', 'RM-11')`.
- `allowedEvents`, filtre `SUBMIT_FOR_REVIEW` : ajouter `&& !!c.currentVersionId`.
- Tests domaine : un contrat sans `currentVersionId` ne peut pas être soumis et
  `allowedEvents` ne liste pas `SUBMIT_FOR_REVIEW`.

## 4. Changements d'API (`apps/api`)

### 4.1 Signataires
- `POST /v1/contracts/:id/signers` *(MSP_ADMIN, ACCOUNT_MANAGER)* — corps
  (`AddSignerDto`) : `party` (LSI/CLIENT), `fullName`, `email`, `signingOrder?`
  (défaut 0), `contactId?`. Uniquement si le contrat est **éditable**
  (DRAFT/CHANGES_REQUESTED). Scopé (404 hors scope). Email dupliqué sur le
  contrat (`@@unique([contractId, email])`) → **409**. Renvoie le signataire créé.
- `DELETE /v1/contracts/:id/signers/:signerId` *(mêmes rôles)* — retire un
  signataire d'un contrat éditable. 404 hors scope / inconnu.

### 4.2 Persistance des approbations (`contracts.service.applyEvent`)
Après le passage par le domaine (qui valide la transition + RM-10 + gardes) :
- `SUBMIT_FOR_REVIEW` → `contractApproval.create({ decision: 'PENDING', versionId: c.currentVersionId, submittedByUserId: event.actorUserId, submittedAt: now })`.
- `APPROVE` → mettre la PENDING à `APPROVED` (`decidedByUserId`, `decidedAt`).
- `REQUEST_CHANGES` → mettre la PENDING à `CHANGES_REQUESTED` (`decidedByUserId`, `decidedAt`, `reason`).
Le domaine ayant déjà tranché RM-10 (le soumetteur ne peut approuver), l'update
n'est atteint que pour un validateur distinct ; le CHECK base est le filet.

### 4.3 `allowedActions` + `findOne`
- `allowedActions` : charger les vrais signataires (aujourd'hui `signers: []`),
  pour que « Soumettre » apparaisse quand LSI+client+contenu+date sont présents.
- `findOne` : renvoyer `signers` (racine, tous les signataires du contrat) et
  `approval` (dernière approbation : `submittedByUserId`, `decision`, `reason`,
  `decidedByUserId`), en plus de l'existant.

### 4.4 RM-11 (`content.service.saveContent`)
Étendre l'ensemble éditable à `APPROVED`. Si le contrat est `APPROVED` à
l'enregistrement, repasser `status = 'DRAFT'` et `approvedVersionId = null` (la
validation portait sur l'ancienne version). Les statuts non éditables
(IN_REVIEW, SIGNED, ACTIVE…) restent **409**.

## 5. Frontend (fiche contrat)

- **Bloc « Signataires »** : liste (nom, partie, email, ordre) + formulaires
  inline `[+ Signataire LSI]` / `[+ Signataire client]` et suppression, visibles
  en statut éditable + rôle.
- **Barre d'actions de workflow**, pilotée par `allowed-actions` (déjà consommé),
  le rôle (`useMe().roles`) et « pas le soumetteur » :
  - **[Soumettre]** (AM/admin) — visible si `allowed-actions` contient
    `SUBMIT_FOR_REVIEW`.
  - **[Approuver]** / **[Demander des modifications]** (LEGAL_REVIEWER/admin) —
    visibles si `allowed-actions` le permet **et** l'utilisateur courant n'est
    pas `approval.submittedByUserId` (RM-10) ; « Demander des modifications »
    ouvre une **modale motif**.
  - **[Annuler]** (AM/admin) — modale motif (EC-09).
- **Statut d'approbation** affiché : « Soumis par … · en attente de revue /
  approuvé / modifications demandées : \<motif\> ».
- Chaque action : `useMutation` → POST endpoint → invalidation de
  `['contract', id]` + `['allowed-actions', id]`. Erreurs API (409/403/422)
  inline.

## 6. Provisionnement, sécurité, tests

- **RM-10 à deux personnes** : approuver exige un utilisateur ≠ le soumetteur.
  Un **utilisateur relecteur** (LEGAL_REVIEWER) sera provisionné en prod au
  déploiement (email fourni par l'utilisateur). La gestion des utilisateurs en
  UI est un incrément ultérieur.
- **Sécurité** : signataires et transitions scopés + gardés par rôle + testés
  IDOR (l'AM de A n'agit pas sur le contrat de B → 404). Le front ne porte
  aucune autorisation.
- **Tests API** :
  - signataires : ajout/suppression scopés, 409 email dupliqué, 404 IDOR.
  - domaine : soumission bloquée sans `currentVersionId` ; `allowedEvents` sans
    `SUBMIT` alors.
  - cycle : un contrat avec contenu + signataires LSI/client se soumet (crée une
    approbation PENDING) ; **le soumetteur ne peut PAS l'approuver (RM-10) →
    409** ; un autre utilisateur (LEGAL_REVIEWER) approuve → `contract_approval`
    APPROVED + statut APPROVED ; `REQUEST_CHANGES` → CHANGES_REQUESTED + motif.
  - RM-11 : éditer un contrat APPROVED le repasse en DRAFT (approvedVersionId
    nul).
  - `allowed-actions` reflète les signataires (SUBMIT présent seulement quand
    LSI+client+contenu+date).
- **Tests SPA** : bloc signataires (ajout appelle le bon endpoint) ; boutons de
  workflow affichés selon `allowed-actions`/rôle/soumetteur ; modale motif
  requise pour « demander des modifications » et « annuler ».

## 7. Déploiement

**Aucune migration** (`contract_signers` et `contract_approvals` existent). Même
image, même stack. Après redéploiement : provisionner le relecteur, puis
vérifier en prod le cycle contenu → signataires → soumettre → (relecteur)
approuver.
