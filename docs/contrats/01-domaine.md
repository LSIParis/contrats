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
| `PricingSchedule`, `PricingLine` | `pricing_schedules`, `pricing_lines` | lot 3 |
| `PriceIndex`, `PriceIndexValue` | `price_indexes`, `price_index_values` | lot 3 |
| `PriceOverride` | `price_overrides` | lot 3 |
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

## 5. Migrations de la passe v2

| # | Objet |
|---|---|
| 17 | Socle : rôles `INTERNAL_SIGNATORY` / `READER`, feature flags, paramètres, `stored_documents`, `lifecycle_events` + trigger |
| 18 | Nouvelles valeurs d'énumération du cycle de vie (séparées : règle PostgreSQL 55P04) |
| 19 | Cycle de vie : acceptation, reconduction, préavis en mois, résiliation programmée, périodes (backfill **testé** `app_backfill_initial_periods`) |
| 20 | Import (`contract_imports`) et échéancier (`deadlines`, rappels rattachés) |
| 22 | Lot 2 : bibliothèque de clauses versionnée, composition des modèles, clauses et annexes des versions de contrat, revues de clauses, variables manquantes |

## 6. Contrats types, clauses, variables, annexes (lot 2)

```
clause_library_items ──< clause_library_item_versions (immuables)
        ▲                              ▲
        │ code = clause_key            │ épinglée
contract_template_versions ──< template_clauses (position, required)
        │  + default_annexes, default_pricing
        ▼ (création d'un contrat : COPIE)
contract_versions ──< contract_clauses (figées, origin TEMPLATE|LIBRARY|CUSTOM|AI)
        │         ──< annexes (SLA, ASSETS, PRICING_GRID, DPA_ART28, OTHER)
        └── body_html = document composé (articles numérotés + annexes)
contract_clause_reviews (append-only) : revue humaine, obligatoire pour les clauses IA
```

- **Une mise à jour de modèle ne modifie jamais un contrat émis** : à la
  création, les clauses du modèle sont **copiées** dans la version 1 du
  contrat ; le modèle ne pointe que des versions de clauses **épinglées**.
- **Variables typées** (`packages/domain/src/templates/variables.ts`) :
  registre (`client.raisonSociale`, `contrat.dureeMois`,
  `sla.delaiIntervention`…) validé par Zod ; une variable hors registre est
  refusée sauf déclaration par le modèle. Les valeurs sont **échappées** au
  rendu ; une variable sans valeur devient un marqueur visible
  `[à compléter : …]`, comptée dans `contracts.missing_variables`, et bloque
  la soumission en revue (garde V2-VAR). Pré-remplissage : client,
  prestataire, dates et préavis du contrat.
- **Écarts au modèle** (`clause-diff.ts`) : clauses ajoutées, modifiées,
  retirées (dont obligatoires), calculés sur `clause_key` avec normalisation
  typographique ; exposés par `GET /v1/contracts/:id/structure` et à
  surligner en revue interne.
- **Document composé** (`compose.ts`) : titre, référence, « Article N —
  Titre », annexes chacune sur une nouvelle page. C'est `body_html` qui est
  prévisualisé, exporté, rendu en PDF figé (SHA-256) et signé ; le pied de page
  (référence, « page X / Y », paraphes DocuSeal si activés) est ajouté au rendu.
- **HTML assaini** à l'écriture (liste blanche : titres, paragraphes, listes,
  liens, tableaux simples, `mark`) ; rendu Gotenberg sans JavaScript ni
  réseau.
- **Revue des clauses IA** : une validation porte sur un TEXTE ; elle suit la
  clause d'une version à l'autre tant que son corps est inchangé et tombe dès
  qu'il change. Aucune décision n'est recopiée : l'historique est relu.
  L'éditeur libre est fermé aux contrats `origin = AI`.
- **Négociation / acceptation** : `send-to-client`, `negotiate`,
  `reopen-negotiation`, acceptation portail (`/v1/portal/contracts/:id/accept`,
  identité de session, IP) ou enregistrée par LSI (pièce justificative
  obligatoire) → `contract_acceptances`.
