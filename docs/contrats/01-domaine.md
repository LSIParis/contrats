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
| tenant | `tenant_id` | `users`, `roles`, `user_roles`, `customer_access`, `customers`, `contract_templates(+_versions)`, `tenant_feature_flags`, `tenant_settings`, `clause_library_items(+_versions)`, `price_indexes(+_values)`, `pricing_rules`, `api_clients`, `webhook_subscriptions`, `webhook_events` (outbox, `customer_id` nullable), `webhook_deliveries` |
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
| (webhooks sortants, brief §8) | `webhook_subscriptions`, `webhook_events`, `webhook_deliveries` | lot 5 : abonnements (secret chiffré), outbox transactionnelle append-only, livraisons et reprises (07-api.md §5) |
| `AuditLog` | `audit_logs` | append-only, **chaîné par empreinte** |
| — | `contract_acceptances` | acceptation d'une version, distincte de la signature |
| — | `contract_periods` | historique des périodes (initiale, reconductions) |
| — | `contract_imports` | pipeline OCR → extraction → validation |
| `Proposal`, `ProposalVersion`, `ProposalSection` / `ProposalBlock`, `ProposalTemplate`, `ContentLibraryItem`, `PricingTable` / `PricingOption`, `ProposalSelection`, `PricingSnapshot`, `ProposalRecipient`, `ProposalAccessLink`, `ProposalViewEvent`, `ProposalComment`, `ProposalFollowUp` | `proposals`, `proposal_versions`, `proposal_sections`, `proposal_blocks`, `proposal_templates(+_sections, +_pricing_lines)`, `content_library_items`, `proposal_terms`, `proposal_selections`, `pricing_snapshots`, `proposal_recipients`, `proposal_access_links`, `proposal_view_events` + `proposal_view_stats`, `proposal_comments`, `proposal_follow_ups` + `proposal_deliveries`, `proposal_acceptances`, `proposal_signature_requests` / `_signers` / `_events`, `proposal_lifecycle_events` | lot 9 : voir §7 et `11-propositions.md` §4 |

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
| Un webhook part si et seulement si la modification est validée | outbox écrite dans la transaction métier (`app_publish_webhook_event`), `webhook_events` append-only, UNIQUE `(event_id, subscription_id)` |

## 5. Migrations de la passe v2

| # | Objet |
|---|---|
| 17 | Socle : rôles `INTERNAL_SIGNATORY` / `READER`, feature flags, paramètres, `stored_documents`, `lifecycle_events` + trigger |
| 18 | Nouvelles valeurs d'énumération du cycle de vie (séparées : règle PostgreSQL 55P04) |
| 19 | Cycle de vie : acceptation, reconduction, préavis en mois, résiliation programmée, périodes (backfill **testé** `app_backfill_initial_periods`) |
| 20 | Import (`contract_imports`) et échéancier (`deadlines`, rappels rattachés) |
| 21 | Tarification : `price_indexes(+_values)`, `pricing_rules`, `pricing_schedules`, `pricing_lines`, `price_overrides` ; extension `btree_gist` (04-tarification.md §17) |
| 22 | Lot 2 : bibliothèque de clauses versionnée, composition des modèles, clauses et annexes des versions de contrat, revues de clauses, variables manquantes |
| 23 | Lot 5 : webhooks sortants — `webhook_subscriptions`, `webhook_events` (outbox), `webhook_deliveries` ; `app_publish_webhook_event` (publication dans la transaction de l'appelant, bornée au tenant/scope courant), `app_find_due_webhook_deliveries` (découverte, identifiants seuls) |
| 30 | Lot 9 : valeurs d'énumérations seules (55P04) — `ContractOrigin.PROPOSAL`, `PricingRecurrence.QUARTERLY`, documents de proposition |
| 31 | Lot 9 : propositions commerciales — tables de classe tenant (bibliothèque, CGV, modèles, compteur) et client (propositions et filles), `contracts.proposal_id` UNIQUE, `customers.commercial_status`, `contract_templates.slug`, RLS + lecture confinée du lien public, trigger de transition, gardes d'immuabilité, découverte et purge `SECURITY DEFINER` |
| 32 | Lot 9 : date d'effet souhaitée, erreur de conversion, découverte des preuves de signature à rapatrier |

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

## 7. Propositions commerciales (lot 9, migrations 30 à 32)

Carte complète : `11-propositions.md` §4. Points de modèle :

- **Classe tenant** : `content_library_items` (clé stable, compteur `version`,
  `user_modified_at` qui protège de l'écrasement par le seed),
  `proposal_terms` (CGV **immuables**, empreinte), `proposal_templates` et
  leurs sections / lignes de prix (forme de l'annexe C, cible du seed),
  `proposal_sequences` (numérotation `PROP-AAAA-NNNN` atomique).
- **Classe client** : `proposals` et toutes ses tables filles portent
  `tenant_id` + `customer_id`, FK composites `(id, tenant_id, customer_id)`.
  Un **prospect** est un `Customer` au statut `commercial_status = PROSPECT`
  (V2-H44).
- **Invariants en base** : version de proposition figée dès l'envoi (trigger
  `proposal_versions_guard`, sections / blocs compris) ; journal
  `proposal_lifecycle_events` écrit **uniquement** par le trigger
  `proposals_status_transition` (+ audit chaîné) ; sélections, snapshots,
  acceptations, envois et suivi détaillé **append-only** ; acceptation par clic
  impossible sans e-mail vérifié (CHECK) ; une seule soumission DocuSeal
  active par proposition (index partiel) ; un contrat par proposition
  (`contracts_proposal_key`).
- **RLS** : aucune ligne de proposition lisible par un acteur `CLIENT`
  (portail) ; la page publique lit par des politiques `*_link_read`
  confinées à UNE proposition (GUC `app.proposal_id`), sans aucune écriture.
