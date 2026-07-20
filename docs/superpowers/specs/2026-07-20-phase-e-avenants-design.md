# Phase E — Avenants (§6.12)

**Date** : 2026-07-20
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : créer un **avenant** (contrat `type=AMENDMENT` lié au parent, portant
les **nouvelles valeurs**), le faire suivre le cycle complet, et **reporter ses
champs sur le parent à la signature** (RM-18) avec régénération des rappels
(EC-12). MVP « un avenant à la fois ».

## 1. Objectif et constat

Dernier morceau du §6.12. Le socle est complet :
- **Domaine** : `assertCanAmend(parent)` (RM-17 parent ACTIVE/SIGNED ; RM-19 pas
  d'avenant déjà ouvert → BusinessRuleError) ; `ContractType='AMENDMENT'` ;
  `openAmendmentExists` ; **`replanAfterEndDateChange(c, now)`** (EC-12).
- **Schéma** : `parentContractId`, index unique partiel `contracts_one_open_amendment`
  (`parent_contract_id WHERE type='AMENDMENT' AND status NOT IN (terminaux)`),
  CHECK `contracts_amendment_has_parent`.
- **Rappels** : posés à l'activation via `planReminders` (`lifecycle.service`).

Ce qui **manque** : l'endpoint de création d'avenant, le report RM-18 à la
signature (+ replan EC-12), et l'UI. Les **métadonnées** d'un contrat (date de
fin, montant) n'étant pas éditables après création, l'avenant **porte les
nouvelles valeurs dès sa création**. **Aucune migration.**

## 2. Décisions

| Sujet | Décision |
|---|---|
| Créer | `POST /v1/contracts/:id/amend` *(parent ACTIVE/SIGNED, MSP_ADMIN/ACCOUNT_MANAGER)*. DTO = nouvelles valeurs (`endDate?`, `amountCents?`) + `reason` (description obligatoire). |
| Garde | `assertCanAmend` (RM-17/RM-19) → 409. Filet base : P2002 sur `contracts_one_open_amendment` → 409. |
| Avenant | Contrat `type=AMENDMENT`, DRAFT, pré-rempli du parent (titre + « — avenant », champs copiés **sauf** ceux modifiés), `parentContractId`=parent. Suit le **cycle normal** (contenu, signataires, soumission, validation, signature). |
| RM-18 (report) | À la signature de l'avenant (hook webhook, comme le renouvellement) : reporter `endDate`/`amountCents` de l'avenant **sur le parent** ; si le parent est ACTIVE, régénérer ses rappels sur la nouvelle date de fin (EC-12, `replanAfterEndDateChange`). |
| Champs reportés | **date de fin + montant** (périmètre/catégorie → plus tard). |
| Limitation MVP | Un avenant **signé** reste non-terminal (occupe le créneau RM-19) : cet increment permet **un** avenant appliqué ; l'enchaînement de plusieurs avenants (état « appliqué → terminal ») est un follow-up. |

## 3. API (`apps/api/src/contracts/`)

### 3.1 `POST /v1/contracts/:id/amend`
DTO `AmendContractDto` : `reason` (`@IsString @MinLength(1) @MaxLength(2000)`),
`endDate?` (`@IsDateString`), `amountCents?` (`@IsInt @Min(0)`).

Service `amend(scope, id, dto, session, now)` (une transaction `withScope`) :
1. Charger le parent (404 hors scope). `assertCanAmend(snapshot)` → BusinessRuleError→409 (rule RM-17/RM-19).
2. Créer l'avenant : `type=AMENDMENT`, `status=DRAFT`, `reference=nextReference(...)`, `title = parent.title + ' — avenant'`, `customerId`/`category`/`currency`/`billingFrequency`/`noticePeriodDays`/`startDate` copiés du parent, `endDate = dto.endDate ? new Date(dto.endDate) : parent.endDate`, `amountCents = dto.amountCents ?? parent.amountCents`, `parentContractId = parent.id`, `ownerUserId = session.userId`. Entourer d'un catch P2002 → 409 (`AMENDMENT_ALREADY_OPEN`).
3. Réponse `{ id, reference }`.

### 3.2 RM-18 — report à la signature (`docuseal-webhook.service`)
Dans le cas `FORM_COMPLETED` (après le passage à SIGNED, si `allSigned`), en
plus du hook renouvellement existant : si le contrat signé est un
**avenant** (`type='AMENDMENT'` avec `parentContractId`), dans la même
transaction :
- charger le parent ;
- `parent.update({ endDate: amendment.endDate, amountCents: amendment.amountCents })` (les nouvelles valeurs) ;
- si le parent est **ACTIVE** : régénérer ses rappels — `reminder.deleteMany({ contractId: parent.id, status: 'PENDING' })` puis reposer via `planReminders`/`replanAfterEndDateChange` sur la nouvelle `endDate` (EC-12). Si le parent est SIGNED (rappels pas encore posés), ne rien reposer — l'activation les calculera sur la bonne date.

Idempotent au rejeu : le report est un set de valeurs (même résultat) ; le replan `deleteMany(PENDING)+create` converge.

### 3.3 `findOne` — exposer les liens d'avenant
Ajouter (additif) :
- `openAmendment` : l'avenant enfant non-terminal `{ id, reference, status }` s'il existe (pour lier + verrouiller le bouton côté parent) ;
- `amends` : `{ id, reference }` si ce contrat est un AMENDMENT (depuis `parentContractId`).

## 4. Frontend (fiche contrat)

Composant `<AmendContract>` :
- **Parent ACTIVE/SIGNED, rôle MSP_ADMIN/ACCOUNT_MANAGER, aucun `openAmendment`** → bouton **[Créer un avenant]** → petit formulaire : nouvelle **date de fin**, nouveau **montant** (€), **description** (obligatoire) → `POST /amend` → **redirige** vers l'avenant (`/contracts/<id>`), qui suit le cycle normal.
- **`openAmendment` présent** → bandeau « Avenant en cours → `<réf>` (`statut`) » (lien).
- **Ce contrat est un avenant** (`amends`) → bandeau « Avenant de `<réf parent>` » (lien).
- Erreurs API (409 RM-17/RM-19) inline.

Intégré à `contract-detail-page.tsx`, près des autres actions de cycle de vie.

## 5. Sécurité et tests

- **API** : scopé (404 hors scope, IDOR B → 404) ; rôle (403) ; avenant sur un
  DRAFT/IN_REVIEW → 409 (RM-17) ; second avenant en cours → 409 (RM-19 / P2002) ;
  l'avenant est bien `type=AMENDMENT` DRAFT lié (`parentContractId`), pré-rempli
  avec les nouvelles valeurs (date de fin/montant) ; **RM-18** : à la signature
  de l'avenant, le parent reçoit `endDate`/`amountCents`, et si ACTIVE ses
  rappels PENDING sont régénérés sur la nouvelle date (test via le webhook).
- **Domaine** : `assertCanAmend` déjà couvert — pas de nouveau test domaine.
- **Front** : bouton Créer un avenant selon statut + rôle + absence d'avenant
  ouvert ; formulaire (date/montant/description) ; bandeaux ; POST du bon
  endpoint + redirection.

## 6. Non-objectifs (différés)

- **Avenants successifs** (état « avenant appliqué → terminal » pour libérer le
  créneau RM-19) — nécessite domaine + migration.
- Report du **périmètre/catégorie** (au-delà de date de fin + montant).
- Édition libre des métadonnées d'un contrat hors avenant.
- Demande d'avenant par le **client** (portail).
