# Phase E — Résiliations (§6.13)

**Date** : 2026-07-20
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : permettre de **résilier** un contrat en cours (ACTIVE/SIGNED) avec
motif, date d'effet et respect du préavis (dérogation admin tracée), en
enregistrant l'acte dans `cancellations` ; et **tracer aussi l'annulation**
existante dans la même table. UI dédiée avec confirmation nommée.

## 1. Objectif et constat

Le cycle de vie a un trou : on ne peut pas **résilier** un contrat depuis
l'application. Pourtant tout est prêt côté socle :
- **Domaine** (`packages/domain`) : l'événement `TERMINATE`
  (`reason, effectiveDate, isAdmin, overrideReason?`) valide déjà RM-20 (motif
  obligatoire ; `effectiveDate ≥ aujourd'hui + noticePeriodDays` ; dérogation
  réservée à l'admin avec justification) et fait passer le contrat à
  `TERMINATED` + `terminatedAt`. Transitions `SIGNED → TERMINATE` et
  `ACTIVE → TERMINATE` en place.
- **Schéma** : table `cancellations` (enum `CancellationType` =
  {CANCELLATION, TERMINATION}, `initiatedBy` = {LSI, CLIENT}, `effectiveDate`,
  `noticeRespected`, `overrideReason`, `overrideByUserId`, `createdByUserId`).

Ce qui **manque** : l'endpoint de résiliation, la **persistance** dans
`cancellations` (personne n'écrit cette table aujourd'hui — l'endpoint `cancel`
ne fait que transiter le statut), et l'**UI**. **Aucune migration.**

## 2. Décisions

| Sujet | Décision |
|---|---|
| Endpoint | `POST /v1/contracts/:id/terminate` *(MSP_ADMIN, ACCOUNT_MANAGER)*. |
| Dérogation | `isAdmin = session.roles.includes('MSP_ADMIN')`. Seul un admin peut poser une `effectiveDate` avant la fin du préavis, avec `overrideReason` (tracé). |
| Persistance résiliation | Écrit un `Cancellation` (type=TERMINATION) + statut `TERMINATED`, dans **une** transaction. |
| Persistance annulation | L'endpoint `cancel` existant écrit désormais aussi un `Cancellation` (type=CANCELLATION) — l'acte de gestion est tracé des deux côtés. |
| `initiatedBy` | Champ **obligatoire** (LSI/CLIENT), défaut LSI, pour la résiliation. Pour l'annulation : LSI (acte interne avant signature). |
| Confirmation nommée | Le front exige de **saisir le nom du client** pour activer le bouton Résilier (friction proportionnée à l'irréversibilité, §spec). L'API reste le garde-fou (rôle + domaine) ; le nom n'est pas requis côté API. |

## 3. API (`apps/api/src/contracts/`)

### 3.1 `POST /v1/contracts/:id/terminate`
DTO `TerminateContractDto` :
- `reason: string` (obligatoire, `@MaxLength(2000)`),
- `effectiveDate: string` (`@IsDateString`),
- `initiatedBy: 'LSI' | 'CLIENT'` (`@IsEnum`),
- `overrideReason?: string` (`@IsOptional @MaxLength(2000)`).

Service `terminate(scope, id, dto, session, now)` (une transaction `withScope`) :
1. Charger le contrat (404 hors scope). Construire le snapshot domaine.
2. `applyEvent(snapshot, { type:'TERMINATE', actorUserId: session.userId, reason, effectiveDate: new Date(dto.effectiveDate), isAdmin: session.roles.includes('MSP_ADMIN'), overrideReason }, now)`.
   - `InvalidTransitionError` → 409 ; `BusinessRuleError` (RM-20) → 409 (code + rule) — même traduction que `applyEvent` générique.
3. Persister `Cancellation` : `type=TERMINATION`, `reason`, `initiatedBy`,
   `effectiveDate` (date), `noticeRespected = effectiveDate ≥ addDays(now, noticePeriodDays ?? 0)`,
   `overrideReason` + `overrideByUserId = session.userId` si dérogation, `createdByUserId = session.userId`.
4. `contract.update` : `status = TERMINATED`, `terminatedAt`, `updatedByUserId`.
5. Réponse : `{ status: 'TERMINATED', effectiveDate, noticeRespected }`.

### 3.2 `cancel` — trace l'annulation
Sur `CANCEL` (dans le chemin `applyEvent` ou son appelant), après la mise à
jour du statut, créer un `Cancellation` : `type=CANCELLATION`,
`reason = event.reason`, `initiatedBy=LSI`, `effectiveDate = now` (immédiate),
`noticeRespected=true`, `createdByUserId = event.actorUserId`.

## 4. Frontend (fiche contrat)

Composant `<TerminateContract>` visible si `allowed-actions` contient
`TERMINATE` **et** rôle MSP_ADMIN/ACCOUNT_MANAGER (statuts ACTIVE/SIGNED) :
- Bouton **[Résilier]** (rouge) → panneau :
  - **Motif** (obligatoire),
  - **Initié par** : LSI / Client (défaut LSI),
  - **Date d'effet** : `type=date`, défaut = aujourd'hui + `noticePeriodDays`
    (rappel du préavis affiché) ; le contrat expose `noticePeriodDays` via
    `findOne`.
  - Si rôle MSP_ADMIN **et** date d'effet < (aujourd'hui + préavis) → champ
    **Justification de la dérogation** (obligatoire pour envoyer).
  - **Confirmation nommée** : champ « Tapez le nom du client (`<nom>`) pour
    confirmer » ; le bouton **[Confirmer la résiliation]** ne s'active que si la
    saisie == nom du client.
- POST `/terminate` → succès : « Contrat résilié » ; invalide
  `['contract', id]` + `['allowed-actions', id]`. Erreurs API (409 RM-20 /
  préavis) inline.

## 5. Sécurité et tests

- **API** : scopée (404 hors scope, IDOR contrat de B → 404) ; gardée par rôle
  (403) ; résiliation d'un DRAFT/IN_REVIEW → 409 (transition invalide) ;
  préavis non respecté sans admin → 409 RM-20 ; **avec** admin + justification →
  succès + `noticeRespected=false` + `overrideByUserId` posé ; motif vide →
  409 RM-20 ; un `Cancellation` (TERMINATION) est écrit ; le contrat passe
  TERMINATED + `terminatedAt`. `cancel` écrit un `Cancellation` (CANCELLATION).
- **Domaine** : déjà couvert (TERMINATE/RM-20) — pas de nouveau test domaine.
- **Front** : bouton visible selon `allowed-actions` + rôle ; confirmation
  nommée bloque tant que le nom ne correspond pas ; champ dérogation apparaît
  pour l'admin quand la date précède le préavis ; POST du bon endpoint.

## 6. Non-objectifs (différés)

- Demande de résiliation **par le client** via le portail (§portail client).
- Renouvellements / avenants (§6.12).
- Notification/emails de résiliation (le socle notifications existe ; branchement
  ultérieur).
- Édition/annulation d'une résiliation déjà actée (TERMINATED est terminal).
