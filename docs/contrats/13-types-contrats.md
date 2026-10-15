# 13 — Types de contrats et grilles tarifaires par durée d'engagement

> Référentiel des **types de contrats** (Maintenance, Microsoft 365, Téléphonie IP…),
> chacun avec sa **grille tarifaire déclinée par durée d'engagement** ; les codes tarifs
> sont utilisables dans les modèles de propositions, les propositions, les barèmes de
> contrat et le devis rapide. Migration `00000000000034_types_contrats`.
> Écrans : **Administration → Types de contrats** (`/contract-kinds`).

## 1. Types de contrats

| Champ | Règle |
|---|---|
| Libellé, description, ordre d'affichage | libres |
| Préfixe | unique par tenant, `^[A-Z0-9]{2,6}$` (CHECK en base) ; **figé dès qu'un code tarif l'utilise** (trigger `app_guard_contract_kind`) |
| Actif / archivé | `archived_at` ; un type archivé n'est plus proposé (sélecteur, nouveaux codes) |
| Prédéfini | `is_system` + `system_key` (clé stable du seed) : **ne se supprime pas** (trigger), il s'archive |
| Contenu contractuel | `contract_template_id` → modèle de contrat (§5) |

Un type **créé par l'utilisateur** suit exactement les mêmes règles : aucune logique
n'est propre aux sept types prédéfinis, hors l'interdiction de les supprimer. Un type
personnalisé se supprime tant qu'il n'a aucun code ; ensuite il s'archive.

Types prédéfinis (`pnpm seed:contract-kinds`, idempotent, sans tarifs ni contenu) :

| Clé stable | Type | Préfixe proposé |
|---|---|---|
| `HORS_MAINTENANCE` | Hors maintenance | HM |
| `MAINTENANCE` | Maintenance | MNT |
| `MICROSOFT_365` | Microsoft 365 | M365 |
| `NEXTCLOUD` | Nextcloud | NXC |
| `TELEPHONIE_IP` | Téléphonie IP | TIP |
| `DPO_EXTERNALISE` | DPO externalisé | DPO |
| `RSSI` | RSSI | RSSI |

Le seed retrouve un type par sa clé stable : libellé et préfixe modifiés dans
l'application sont conservés. Si un préfixe proposé est déjà pris par un type
personnalisé, le type prédéfini n'est pas créé et c'est signalé.

## 2. Durées d'engagement

Table `commitment_terms` (référentiel du tenant) : **0 (sans engagement), 12, 24, 36
mois** au seed ; d'autres durées s'ajoutent depuis l'écran (0 à 99 mois). Le nombre de
mois est **figé** une fois créé (il figure dans les codes `E00`…`E99`) ; une durée
s'archive, elle ne se supprime pas.

## 3. Grille tarifaire et codes

| Niveau | Table | Code | Contenu |
|---|---|---|---|
| Code de base | `price_grid_items` | `{PREFIXE}-{NNNN}` (ex. `M365-0003`) | libellé, description, unité, périodicité (mensuelle, annuelle, ponctuelle), TVA, actif/archivé |
| Version par durée | `price_grid_variants` | `{PREFIXE}-{NNNN}-E{DD}` (ex. `M365-0003-E12`) | une par durée proposée |
| Prix | `price_grid_prices` | — | prix de vente HT, prix d'achat facultatif, **date d'effet** |

Garanties portées par la base :

- **codes calculés par la base** (triggers `app_assign_price_grid_item_code`,
  `app_assign_price_grid_variant_code`) à partir du préfixe et de la durée ; numérotation
  propre à chaque type, sans trou, sérialisée par le verrou de ligne du type ;
- **uniques** par tenant et **jamais réattribués** : DELETE révoqué sur les codes et les
  versions, compteur `last_item_number` qui ne recule pas ; code, numéro, type et durée
  non modifiables (droits par colonne) ;
- **historique** : un prix ne se réécrit jamais (UPDATE/DELETE révoqués). Un changement
  de prix est une nouvelle ligne datée ; prix en vigueur à une date D = plus grande date
  d'effet ≤ D, puis dernière saisie. Les prix futurs sont possibles (affichés « → X € au … »).

Une durée **non proposée** pour un code n'a pas de version (ou une version archivée) :
elle n'apparaît pas à la sélection. La remettre en vente réactive la **même** version,
avec le même code. Unités : `PRICE_UNITS` de `@lsi/domain` (par utilisateur, par poste,
par licence, à l'unité, forfait, heure). Montants en euros, `numeric(20,6)`.

## 4. API (`/v1`, lecture : `contracts.read` ou `proposals.read` ; écriture : `pricing.grid.manage`, MSP_ADMIN)

| Route | Rôle |
|---|---|
| `GET/POST /contract-kinds`, `GET/PUT/DELETE /contract-kinds/:id`, `POST …/archive\|unarchive` | types |
| `GET/POST /commitment-terms`, `PUT /commitment-terms/:months` | durées |
| `GET /contract-kinds/:id/grid?on=&archived=` | grille (prix en vigueur à `on`, prochain prix) |
| `POST /contract-kinds/:id/grid/items` | nouveau code (avec ses prix par durée) |
| `PUT /price-grid/items/:code`, `POST …/prices`, `POST …/archive\|unarchive`, `GET …/history` | code de base, prix datés, historique |
| `GET /contract-kinds/:id/grid.csv`, `POST /contract-kinds/:id/grid/import` | CSV (§6) |
| `GET /price-grid/variants?kindId=&months=&q=&on=` | **sélecteur** des documents (versions actives ayant un prix en vigueur) |
| `GET /price-grid/variants/:code?on=` | une version : ce qu'un document copie |

## 5. Contenu contractuel (à fournir)

Aucun texte n'est rédigé à ce stade. L'emplacement est le **modèle de contrat** existant
(`contract_templates`), relié au type par `contract_kinds.contract_template_id` :

- versions du modèle, figées à la publication, avec **date d'effet** (`effective_from`,
  ajoutée par la migration 34 ; `POST /v1/templates/:id/publish { effectiveFrom }`) ;
- clauses de bibliothèque versionnées (conditions générales et particulières, périmètre,
  niveaux de service, clauses spécifiques) ;
- annexes par défaut (`default_annexes` : SLA, grille tarifaire, accord de traitement…).

**Quand le contenu sera fourni** : un modèle de contrat par type (clauses `CT-…` et
annexes dans `contract-templates-data.ts`, installées par `pnpm seed:contract-templates`),
relecture juridique, publication avec sa date d'effet, puis rattachement au type
(onglet « Contenu contractuel » ou `PUT /v1/contract-kinds/:id { contractTemplateId }`).

## 6. Import / export CSV

`code;libelle;description;unite;periodicite;tva;E00;E12;E24;E36;achat_E00;…`
(séparateur `;`, UTF-8 avec BOM, virgule ou point décimal).

- `code` vide = nouveau code de base (numéro attribué par la base) ; code d'un autre
  type, inconnu ou archivé = erreur ;
- unité et périodicité : libellé (« par utilisateur », « mensuelle ») ou code ;
- colonne `Edd` absente = durée inchangée ; **cellule vide = version non proposée** ;
- date d'effet des prix : champ du formulaire (défaut : aujourd'hui) ;
- **tout ou rien**, toutes les erreurs listées par ligne ; l'aperçu (`dryRun=true`)
  calcule le même rapport puis annule (aucun numéro consommé) ; un prix identique à celui
  en vigueur n'est pas réécrit (import rejouable).

## 7. Utilisation dans les documents

Principe commun : à l'ajout, **code, libellé, prix et TVA sont COPIÉS** dans la ligne du
document ; une modification ultérieure de la grille ne touche jamais un document existant.

| Document | Ajout | Durée du document |
|---|---|---|
| **Modèle de proposition** (composition commerciale) | « Ajouter depuis la grille tarifaire » ; « Grille » sur une ligne existante la rattache à un code (prix par durée repris, ligne validée) | les durées du modèle (choix d'engagement) |
| **Proposition** (devis) | « Ajouter depuis la grille » : une version par durée proposée, refus si une durée n'a pas de version (versions manquantes listées), refus si la TVA du code diffère de celle de la proposition | « Durées proposées » : 0 (sans engagement), 12, 24, 36… ; s'il y a des lignes de grille, **confirmation** : basculer vers les versions et prix des durées retenues, ou conserver les prix copiés (seules les nouvelles durées sont lues dans la grille) |
| **Barème de contrat** | « Ajouter depuis la grille » (code de version = code article, ligne en mode manuel) | si l'engagement du barème change (vide = sans engagement), les lignes de grille d'une autre durée sont signalées avec « Basculer vers les versions … » |
| **Devis rapide** (cotation) | bouton « Grille » à côté du code article | un code de version se chiffre au prix en vigueur à la date |

Détails :

- une ligne de proposition issue de la grille porte `grid { itemCode, variants, vatRatePercent, on }`
  (`variants` : code de version par valeur du choix d'engagement) ; ses prix, s'ils sont
  exactement ceux de la grille, sont **validés** (la grille est tenue par l'administrateur) ;
  modifiés à la main, ils repassent « à valider » ;
- à la conversion d'une proposition signée, le **code de la version retenue** devient le
  code article de la ligne du barème du contrat ;
- **sans engagement** : option de 0 mois autorisée dans les propositions ; le total
  d'engagement n'est pas affiché ; converti, le contrat n'a pas de date de fin et son barème
  pas d'engagement (`commitment_months` NULL) ;
- retirer la durée en cours d'une proposition ramène sa configuration à la durée par défaut ;
- les lignes libres hors grille restent possibles partout où elles l'étaient.

## 8. Exploitation

- Migration 34 additive ; retour arrière : `prisma/rollback/00000000000034_types_contrats.down.sql`
  (destructif, à jouer en propriétaire puis `migrate deploy` ; testé montée → descente → montée).
- Seed : `pnpm seed:contract-kinds` (propriétaire de la base, `SEED_TENANT_SLUG`, défaut `lsi`).
  Le job `migrate` le joue quand `SEED_PROPOSAL_TEMPLATES=true` (même drapeau que les modèles
  de propositions, déjà transmis par le compose).
- Les grilles se saisissent dans l'application (ou par import CSV) : aucun tarif n'est livré.
