# 01 — Modèle de domaine

> Le schéma de référence est `packages/persistence/prisma/schema.prisma`,
> commenté champ par champ. Ce document en donne la carte, les invariants et
> la correspondance avec le brief (§1). Toute évolution passe par une
> migration **additive** (`packages/persistence/prisma/migrations/`),
> contrôlée par `pnpm db:check-drift`.

## 1. Trois classes de tables

| Classe | Colonnes de portée | Tables |
|---|---|---|
| plateforme | aucune | `tenants` |
| tenant | `tenant_id` | `users`, `roles`, `user_roles`, `customer_access`, `customers`, `contract_templates(+_versions)`, `tenant_feature_flags`, `tenant_settings`, `clause_library_items(+_versions)`, `price_indexes(+_values)`, `pricing_rules`, `api_clients`, `webhook_subscriptions` |
| client | `tenant_id` + `customer_id` | tout le reste : `contracts` et toutes leurs tables filles |

- `customer_id` est **dénormalisé** sur toutes les tables filles : une
  politique RLS lit la portée sur la ligne elle-même, sans jointure.
- La cohérence est garantie par des **FK composites** `(id, tenant_id,
  customer_id)` : une ligne du client A ne peut pas pointer un objet du client B.
- **RLS** `ENABLE` + `FORCE` + au moins une politique `USING` **et**
  `WITH CHECK` sur chaque table métier ; un test structurel l'impose
  (`packages/persistence/tests/isolation/database-guarantees.test.ts`).
- L'application se connecte avec `lsi_app` (ni propriétaire, ni `BYPASSRLS`) ;
  toute requête passe par `withScope()` qui pose les GUC de portée pour la
  seule transaction.

## 2. Correspondance avec les entités du brief

| Brief | Table(s) | Notes |
|---|---|---|
| `Tenant` | `tenants` | |
| `Client` | `customers` | + `is_consumer` (loi Chatel), `external_ref` (Client Help, unique par tenant) |
| `ClientContact` | `customer_contacts` | + `signing_capacity` (qualité à signer), `is_signatory` |
| `ContractTemplate` | `contract_templates`, `contract_template_versions` | versions immuables une fois publiées |
| `Clause` / `ClauseLibraryItem` | `clause_library_items`, `clause_library_item_versions`, `template_clauses`, `contract_clauses` | lot 2 |
| `Contract` | `contracts` | origine, statut, dates, reconduction, préavis (jours **ou** mois), résiliation |
| `ContractVersion` | `contract_versions` | **immuable** (UPDATE/DELETE révoqués, sauf l'écriture unique du PDF et de son empreinte) |
| `Annex` | `annexes` | lot 2, rattachée à une version |
| `Amendment` | `contracts` de type `AMENDMENT` | choix historique RM-17 : un avenant a son propre cycle de signature |
| `PricingSchedule`, `PricingLine` | `pricing_schedules`, `pricing_lines` | lot 3 : version DRAFT → ACTIVE → SUPERSEDED, sans chevauchement (EXCLUDE), figée une fois engagée (trigger) ; `line_key` stable entre versions |
| `PriceIndex`, `PriceIndexValue` | `price_indexes`, `price_index_values` | lot 3 : valeurs **append-only**, correction chaînée (`supersedes_id`) |
| `PriceOverride` | `price_overrides` | lot 3 : bornée, motivée, double validation au-delà du seuil |
| — | `pricing_rules` | lot 3 : catalogue de règles du tenant (grilles, paliers, remises) |
| `SignatureRequest` | `signature_requests`, `signature_events` | idempotence des webhooks par contrainte unique |
| `LifecycleEvent` | `lifecycle_events` | **écrit par trigger**, append-only (§4) |
| `Deadline` | `deadlines` | échéancier matérialisé, alertes via `reminders` |
| `StoredDocument` | `stored_documents` | **écriture unique**, empreinte SHA-256 |
| `ApiClient` | `api_clients` | lot 7 |
| `AuditLog` | `audit_logs` | append-only, **chaîné par empreinte** |
| — | `contract_acceptances` | acceptation d'une version, distincte de la signature |
| — | `contract_periods` | historique des périodes (initiale, reconductions) |
| — | `contract_imports` | pipeline OCR → extraction → validation |

## 3. Montants et dates

- **Montants** : jamais de flottant. Totaux en centimes `BigInt` ; prix
  unitaires en `Decimal(20,6)` euros (fractions de centime possibles) ;
  arrondi explicite (`04-tarification.md`).
- **Dates** : instants en UTC (`timestamp(3)`), dates contractuelles en
  `date` (sans heure) ; affichage en `Europe/Paris` côté interface.

## 4. Invariants garantis par la base

| Invariant | Mécanisme |
|---|---|
| Aucune lecture/écriture hors portée | RLS `USING` + `WITH CHECK`, rôle non propriétaire |
| Cohérence client ↔ objets rattachés | FK composites `(id, tenant_id, customer_id)` |
| Toute transition d'état tracée | trigger `contracts_status_transition` → `lifecycle_events` + `app_append_audit` |
| Journal d'audit infalsifiable sans détection | chaînage SHA-256 sous verrou consultatif, UPDATE/DELETE révoqués |
| Versions et preuves non modifiables | REVOKE UPDATE/DELETE (`contract_versions`, `stored_documents`, `contract_acceptances`, `contract_periods`, `lifecycle_events`) |
| Un contrat ne change pas de client | FK NO ACTION depuis l'historique append-only |
| Préavis sans ambiguïté | CHECK jours **ou** mois |
| Reconduction complète | CHECK `renewal_mode = NONE` ou durée renseignée |
| Pas de doublon d'échéance ni d'alerte | UNIQUE `(contract, kind, due_date)` et `(contract, kind, offset, cycle)` |
| Validation d'import complète | CHECK « tout ou rien » sur (qui, quand, quoi) |
| Un valideur n'approuve pas sa propre soumission | CHECK `decided_by <> submitted_by` |
| Deux versions engagées d'un barème ne se chevauchent pas | EXCLUDE gist `(contract_id =, daterange &&)` |
| Barème engagé et ses lignes immuables | triggers `pricing_schedules_guard`, `pricing_lines_guard` |
| Valeur d'indice jamais réécrite | UPDATE/DELETE révoqués ; correction chaînée (UNIQUE `supersedes_id`) |
| Dérogation : auteur ≠ second validateur ; prix et motif figés | CHECK `approved_by_user_id <> author_user_id` ; GRANT UPDATE limité aux décisions |

## 5. Migrations de la passe v2

| # | Objet |
|---|---|
| 17 | Socle : rôles `INTERNAL_SIGNATORY` / `READER`, feature flags, paramètres, `stored_documents`, `lifecycle_events` + trigger |
| 18 | Nouvelles valeurs d'énumération du cycle de vie (séparées : règle PostgreSQL 55P04) |
| 19 | Cycle de vie : acceptation, reconduction, préavis en mois, résiliation programmée, périodes (backfill **testé** `app_backfill_initial_periods`) |
| 20 | Import (`contract_imports`) et échéancier (`deadlines`, rappels rattachés) |
| 21 | Tarification : `price_indexes(+_values)`, `pricing_rules`, `pricing_schedules`, `pricing_lines`, `price_overrides` ; extension `btree_gist` (04-tarification.md §17) |
