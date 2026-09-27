# 04 — Tarification (`packages/pricing`, `@lsi/pricing`)

> Spécification du moteur de tarification (brief §5). Le code fait foi pour le
> détail ; ce document fait foi pour les **règles** (arrondis, révision,
> dérogations). Toute divergence est un bogue de l'un ou de l'autre.

## 1. Objet

Chaque contrat porte **son propre barème**, versionné et daté. Le moteur
répond à une seule question : *quel est le prix de chaque ligne, et le total,
à telle date ?* — avec la **justification** complète du calcul (trace).

Il sert :

- l'API publique (`GET /api/v1/contracts/{id}/pricing?at=`, `POST /api/v1/pricing/quote`) ;
- le simulateur de l'interface (impact d'une révision ou d'un changement de quantité) ;
- le chiffre d'affaires récurrent contractualisé (`monthlyRecurringCents`).

Hors périmètre : la facturation (voir `00-architecture.md` §7).

## 2. Architecture

```
            couche persistance (@lsi/persistence / apps/api)
  ┌───────────────────────────────────────────────────────────────┐
  │ 1. charger l'instantané : barèmes, indices, dérogations,     │
  │    catalogue de règles, paramètres du tenant (withScope)      │
  │ 2. await resolveQuantities(input, contractRef, date, provider)│  ← asynchrone, E/S
  │ 3. priceAt({ ...input, quantities }, date)                    │  ← synchrone, PUR
  └───────────────────────────────────────────────────────────────┘
```

`@lsi/pricing` ne dépend **ni de Prisma, ni de HTTP, ni de la base**. Sa seule
dépendance d'exécution est `decimal.js` (arithmétique décimale exacte). Toutes
les fonctions exportées sont pures et déterministes : aucune horloge, aucun
aléa, aucune mutation de l'entrée (vérifié par test de propriété sur entrée
gelée). Même entrée → même sortie, trace comprise : un prix facturé il y a
trois ans se rejoue à l'identique.

| Fichier | Rôle |
|---|---|
| `money.ts` | Decimal (clone local, 40 chiffres), `toCents`, `roundToScale`, `parseDecimal`, `parseIsoDate` |
| `formula/*` | analyseur lexical, analyseur syntaxique, évaluateur, `validateFormula` |
| `indexes.ts` | `lookupIndexValue` (LATEST_PUBLISHED / EXACT_PERIOD) |
| `revision.ts` | `computeRevision`, `assertRevisionCoefficients` |
| `tiers.ts` | `computeTiered` (GRADUATED / VOLUME) |
| `rules.ts` | catalogue : grille, remise volume, remise d'engagement |
| `overrides.ts` | `validateOverride`, `selectOverride`, seuil de double validation |
| `schedule.ts` | `selectSchedule`, `resolveSettings` |
| `price-at.ts` | `priceAt`, `computeTotals` |
| `quantity.ts` | `QuantityProvider`, `FakeQuantityProvider`, `resolveQuantities` |
| `simulate.ts` | `simulate` |
| `serialize.ts` | `toJsonSafe` (bigint → chaîne) |
| `trace.ts` | type `TraceStep` |

## 3. Données d'entrée

Types plats et sérialisables en JSON (`types.ts`) :

| Donnée | Format |
|---|---|
| Prix unitaire, montant de remise | chaîne décimale en euros, **≤ 6 décimales** (`"0.0125"`) — stockage `Decimal(20,6)` |
| Pourcentage (TVA, remise) | chaîne décimale (`"20"`, `"5.5"`) |
| Quantité | chaîne décimale ≥ 0, ≤ 6 décimales (`"1.5"` heure) |
| Valeur d'indice | chaîne décimale, ≤ 10 décimales |
| Date | `"YYYY-MM-DD"` (date calendaire, **pas d'instant, pas de fuseau**) ; bornes **incluses** |
| Période d'indice | `"YYYY-MM"` |
| Montants de sortie | **centimes entiers `bigint`** |

Saisie refusée plutôt qu'interprétée : pas de virgule décimale, pas
d'exposant, pas de `".5"`. La conversion instant → jour calendaire
(`Europe/Paris`) se fait **une fois**, à la frontière (API), jamais dans le moteur.

**Pourquoi `bigint` pour les totaux ?** Un total agrégé n'a pas de plafond
métier, et un `number` au-delà de 2^53 arrondit **sans erreur**. Un `bigint`
ne peut pas perdre un centime en silence. Contrepartie : `JSON.stringify`
refuse les `bigint` ; `toJsonSafe(result)` les convertit explicitement en
chaînes (`"128867"`), et l'API documente ces champs comme tels.

### 3.1 Barème versionné

`PricingSchedule { id, validFrom, validTo | null, currency: 'EUR', lines }`.
À une date, **exactement une** version doit s'appliquer : aucune →
`NO_SCHEDULE`, plusieurs → `OVERLAPPING_SCHEDULES` (on ne départage jamais un
chevauchement par un tri : ce serait un prix qui dépend d'un ordre).

## 4. Lignes : types et modes

### 4.1 Types (`kind`) — ce qui est facturé

| `kind` | Calcul | Récurrence |
|---|---|---|
| `FLAT_MONTHLY` | forfait × quantité (défaut 1) | `MONTHLY` imposée |
| `FLAT_YEARLY` | forfait × quantité | `YEARLY` imposée |
| `UNIT` | prix unitaire × quantité (poste, serveur, utilisateur, licence, site, équipement) | `MONTHLY` par défaut, surchargeable |
| `HOURLY` | taux horaire × heures | `ONE_OFF` par défaut |
| `HOUR_PACK` | prix du pack × nombre de packs ; `hourPack.hoursPerPack` obligatoire, taux horaire effectif tracé | `ONE_OFF` par défaut |
| `SETUP_FEE` | frais de mise en service | `ONE_OFF` imposée |
| `TIERED` | paliers `GRADUATED` ou `VOLUME` (§4.3) | `MONTHLY` par défaut |
| `DISCOUNT` | remise `PERCENT` ou `AMOUNT` sur des lignes désignées ou sur le sous-total (§4.4) | héritée des cibles |

Contredire une récurrence imposée → `INVALID_LINE`.

### 4.2 Modes (`mode`) — comment le prix est déterminé

| `mode` | Source du prix | Champs |
|---|---|---|
| `MANUAL` | prix (ou paliers) saisi sur la ligne | `unitPrice` ou `tiers` |
| `RULE` | catalogue de règles du tenant | `rule: { priceRuleId, adjustmentRuleIds? }` |
| `FORMULA` | expression déclarative (§5) | `formula: { expression, basePrice?, variables?, indexVariables? }` |

La **dérogation** (`PriceOverride`, §8) n'est pas un mode : elle se superpose,
bornée dans le temps, à n'importe lequel des trois. La **révision native**
(`revision`, §6) s'ajoute aux modes `MANUAL` et `RULE` ; en mode `FORMULA`, la
révision s'écrit dans la formule (combiner les deux → `INVALID_LINE`).

Catalogue (`RuleCatalog.rules`) :

| Règle | Usage |
|---|---|
| `GRID` | prix unitaire par **code article** (`line.code`) |
| `TIERS` | table de paliers (ligne `TIERED` uniquement) |
| `VOLUME_DISCOUNT` | % selon le seuil de quantité le plus élevé atteint |
| `COMMITMENT_DISCOUNT` | % selon la durée d'engagement (`context.commitmentMonths`, obligatoire sinon `MISSING_CONTEXT`) |

Les ajustements s'appliquent **en cascade** (multiplicatifs) sur le montant
exact : −5 % puis −3 % = × 0,95 × 0,97 = −7,85 %. Exemple testé : grille 35 €,
25 postes, −5 % volume, −3 % engagement → 32,2525 €/poste → 806,3125 € → **806,31 €**.

### 4.3 Paliers

Un palier couvre `]borne précédente, upTo]` (borne haute incluse, premier palier
depuis 0, `upTo: null` = illimité, seulement en dernier).

- **GRADUATED** (par tranches) : chaque unité au prix de sa tranche.
  1–10 à 30 €, 11+ à 25 € : 12 postes = 10 × 30 + 2 × 25 = **350 €**.
  Le total est **croissant** en quantité (propriété testée, avant et après arrondi).
- **VOLUME** (au palier atteint) : toute la quantité au prix du palier atteint.
  12 postes = 12 × 25 = **300 €**. Le total **n'est pas monotone** :
  10 postes = 300 €, 11 postes = 275 € (effet de seuil, propre à ce modèle
  commercial). Ce qui est garanti et testé : monotonie **dans** un même palier ;
  si les prix des paliers sont décroissants, le prix unitaire moyen ne remonte jamais.

Quantité au-delà du dernier palier borné → `INVALID_LINE` (on ne prolonge pas
le dernier prix en silence). Le prix unitaire affiché d'une ligne en paliers
est un **prix moyen informatif** ; le total est calculé sur le montant exact.

### 4.4 Remises (`DISCOUNT`)

- Calculées **après** les autres lignes, sur leurs totaux **arrondis** (ce que
  le client voit).
- Cibles homogènes en **taux de TVA** et en **récurrence** ; le taux de la
  remise doit être celui des cibles. Sinon `DISCOUNT_TARGET_MISMATCH` : créer
  une remise par taux / par récurrence (ventiler automatiquement une remise
  entre taux est une décision comptable qu'on ne prend pas à la place de l'utilisateur).
- `PERCENT` ≤ 100, `AMOUNT` ≤ base, sinon `DISCOUNT_EXCEEDS_BASE`. Une remise
  ne peut cibler une autre remise.
- Montant **négatif**, arrondi au centime avec la même règle que les autres
  lignes (symétrique : −0,005 € → −0,01 € en arrondi commercial).

## 5. Formules

Moteur **écrit à la main**, sans `eval`, sans `new Function`, sans accès à un
objet JavaScript : tokenizer → analyseur à descente récursive → AST →
évaluateur sur `decimal.js`. Les noms de variables et de fonctions sont
résolus dans des `Map` fermées : `constructor`, `__proto__`, `toString` ne
désignent rien.

### 5.1 Grammaire (EBNF)

```ebnf
formule     = comparaison , EOF ;
comparaison = additif , [ ( "<" | "<=" | ">" | ">=" | "==" | "!=" ) , additif ] ;
additif     = terme , { ( "+" | "-" ) , terme } ;
terme       = unaire , { ( "*" | "/" ) , unaire } ;
unaire      = ( "-" | "+" ) , unaire | puissance ;
puissance   = primaire , [ "^" , unaire ] ;              (* associatif à droite *)
primaire    = nombre | appel | identifiant | "(" , comparaison , ")" ;
appel       = identifiant , "(" , [ comparaison , { "," , comparaison } ] , ")" ;
nombre      = chiffre , { chiffre } , [ "." , chiffre , { chiffre } ] ;
identifiant = ( lettre | "_" ) , { lettre | chiffre | "_" } ;
```

Conséquences : `-2 ^ 2 = -4` ; `2 ^ 3 ^ 2 = 512` ; `1 < 2 < 3` est **refusé**
(comparaison non associative). Point décimal uniquement (la virgule sépare les
arguments). Une comparaison vaut `1` ou `0`.

### 5.2 Liste blanche de fonctions

| Fonction | Sens |
|---|---|
| `min(x, y, …)`, `max(x, y, …)` | ≥ 1 argument |
| `round(x)`, `round(x, n)` | n entier ∈ [0, 10] ; **même mode d'arrondi que le barème** |
| `floor(x)`, `ceil(x)`, `abs(x)` | |
| `if(c, a, b)` | `a` si `c ≠ 0`, sinon `b` ; **paresseux** : `if(S0 == 0, 0, P0 / S0)` ne divise jamais par zéro |

### 5.3 Variables d'une ligne `FORMULA`

Le résultat de l'expression est le **prix unitaire HT**. Variables disponibles :
`qty` (quantité), `P0` (si `basePrice`), les constantes de `variables`, et les
variables liées à un indice (`indexVariables: { S1: { indexCode: 'SYNTEC', date: 'PRICING_DATE' } }`).
Un nom défini deux fois → `INVALID_LINE`. Résultat négatif → `NEGATIVE_PRICE`
(une baisse s'exprime par une ligne `DISCOUNT`).

### 5.4 Gardes et erreurs

Longueur ≤ 1 000 caractères, profondeur d'imbrication ≤ 32 (`FORMULA_LIMIT`),
exposant entier dans [−100, 100]. Erreurs typées `FormulaError` avec
**position** : `FORMULA_SYNTAX`, `FORMULA_UNKNOWN_VARIABLE`,
`FORMULA_UNKNOWN_FUNCTION`, `FORMULA_ARITY`, `FORMULA_LIMIT`,
`FORMULA_EVALUATION`, `DIVISION_BY_ZERO`.

`validateFormula(expr, allowedVariables)` ne lève jamais et renvoie
`{ valid, variables, functions, errors[] }` avec **toutes** les erreurs
sémantiques positionnées (l'éditeur les souligne d'un coup) ; une erreur de
syntaxe arrête l'analyse et produit une seule erreur.

## 6. Révision indicielle native

### 6.1 Formule

```
P1 = P0 × (a + b × S1 / S0)
```

- `a` part fixe, `b` part indexée, **a + b = 1 exactement** (égalité décimale,
  sans tolérance), a ≥ 0, b ≥ 0 — sinon `INVALID_REVISION_COEFFICIENTS` ;
- `S0` : indice à `referenceDate`, `S1` : indice à `revisionDate` ;
- la révision s'applique à partir de `revisionDate` (incluse) ; avant, le prix
  est `P0` et la trace porte `REVISION_NOT_EFFECTIVE` ;
- `S0 = 0` → `DIVISION_BY_ZERO`.

**Ordre des opérations fixé** (il détermine les derniers chiffres
significatifs) : `ratio = S1 / S0`, puis `coefficient = a + b × ratio`, puis
`P1 = P0 × coefficient`. Calcul exact à 40 chiffres significatifs ; le prix
révisé est ensuite arrondi à `unitPriceScale` décimales (§7).

En pratique, chaque révision annuelle crée une **nouvelle version du barème**
(`validFrom` = date de révision) qui conserve `P0` et `referenceDate` et porte
la nouvelle `revisionDate`.

### 6.2 Valeurs d'indice

`PriceIndex { code, name, values: PriceIndexValue { period 'YYYY-MM', value, publishedAt } }`,
saisies ou importées par un connecteur. **Aucune valeur codée en dur, aucune
interpolation.** Règle de recherche explicite (paramètre tenant
`indexLookup`, surchargeable par ligne) :

| Règle | Valeur retenue pour une date D |
|---|---|
| `LATEST_PUBLISHED` (défaut) | période la plus récente ≤ mois de D **et** `publishedAt ≤ D` : « dernier indice connu à la date ». Rejouer le calcul plus tard donne le même résultat. |
| `EXACT_PERIOD` | la période du mois de D, et elle seule (publication ignorée) : clauses « indice du mois d'août N ». |

Absente → `INDEX_VALUE_NOT_FOUND` ; indice inconnu → `INDEX_NOT_FOUND` ; deux
valeurs pour une période → `DUPLICATE_INDEX_VALUE`. Attention : avec
`LATEST_PUBLISHED`, si la valeur de l'année N n'est pas encore saisie, `S1`
retombe sur la dernière valeur connue (éventuellement `S0` lui-même) : le prix
reste `P0`. C'est le comportement voulu (« dernier indice connu »), mais la
saisie des indices doit précéder la date de révision — l'échéancier
(`Deadline` de révision) le rappelle.

### 6.3 Exemple chiffré 1 — forfait mensuel (testé à l'identique)

Données (valeurs **fictives** de test) : Syntec juillet 2025 = 321,5 (publié le
27/08/2025), juillet 2026 = 333,2 (publié le 26/08/2026) ; `a = 0,15`,
`b = 0,85`, `P0 = 1 250,00 €` HT/mois ; `referenceDate = 2025-09-15`,
`revisionDate = 2026-09-01` ; calcul au 2026-09-15, règle `LATEST_PUBLISHED`,
`unitPriceScale = 6`, arrondi commercial, TVA 20 %.

| Étape | Calcul | Valeur (40 chiffres significatifs) |
|---|---|---|
| S0 | dernier publié au 2025-09-15, période ≤ 2025-09 | 321,5 (période 2025-07) |
| S1 | dernier publié au 2026-09-01, période ≤ 2026-09 | 333,2 (période 2026-07) |
| 1. ratio | S1 / S0 = 333,2 / 321,5 | 1,036391912908242612752721617418351477449 |
| 2. b × ratio | 0,85 × ratio | 0,8809331259720062208398133748055987558317 |
| 3. coefficient | a + b × ratio = 0,15 + … | 1,030933125972006220839813374805598755832 |
| 4. P1 exact | P0 × coefficient = 1 250 × … | 1 288,66640746500777604976671850699844479 |
| 5. prix unitaire | arrondi à 6 décimales | **1 288,666407 €** |
| 6. total de ligne | 1 288,666407 × 1 = 128 866,6407 centimes → centime | **1 288,67 €** HT |
| 7. TVA 20 % | 1 288,67 × 0,20 = 257,734 → centime | **257,73 €** |
| 8. TTC | 1 288,67 + 257,73 | **1 546,40 €** |

Avec `unitPriceScale = 2` (prix révisé arrondi au centime), le prix unitaire
vaut 1 288,67 € et le total est identique. Tests :
`tests/revision.test.ts` (« exemple chiffré documenté ») et
`tests/price-at.test.ts` (« révision native »).

### 6.4 Exemple chiffré 2 — prix unitaire × quantité : l'échelle compte

Mêmes indices et coefficients, `P0 = 35,00 €`/poste, 12 postes.

| | `unitPriceScale = 6` (défaut) | `unitPriceScale = 2` |
|---|---|---|
| P1 exact | 36,08265940902021772939346811819595645412 | idem |
| prix unitaire | 36,082659 | 36,08 |
| × 12 | 432,991908 | 432,96 |
| total HT | **432,99 €** | **432,96 €** |

Trois centimes d'écart sur une ligne : le choix de l'échelle du prix révisé
est **contractuel**. Le défaut (6) est le plus fidèle à la formule ; un tenant
qui publie des grilles révisées au centime choisit 2. Le paramètre est tracé
dans chaque étape `ROUNDING`.

## 7. Arrondis

Règle par défaut (**arrondi commercial**, `HALF_AWAY_FROM_ZERO`) : au plus
proche, et à égale distance **à l'écart de zéro** : 0,125 → 0,13 ;
−0,125 → −0,13 (symétrique). Option tenant `HALF_EVEN` (**arrondi au pair**) :
0,125 → 0,12 ; 0,135 → 0,14.

On n'arrondit qu'à quatre endroits nommés, chacun tracé :

1. **prix unitaire calculé** → `unitPriceScale` décimales (défaut 6) ;
2. **total de ligne** → centime (`LINE_TOTAL`) ;
3. **TVA par taux** → centime, calculée sur la **somme HT du taux** (et non
   ligne à ligne : deux lignes à 0,03 € donnent 0,01 € de TVA, pas 0,02 €) ;
4. **récurrent mensuel** → centime, sur la part annuelle / 12.

HT = somme des totaux de ligne (déjà au centime, pas de nouvel arrondi) ;
TTC = HT + TVA. Tous les calculs intermédiaires sont exacts (`decimal.js`,
40 chiffres ; le binaire flottant n'intervient jamais : 2,675 → 2,68 et non 2,67).

Cas limites testés : x,xx5 dans les deux modes, remises négatives
(10 % de 0,05 € = −0,005 € → −0,01 € commercial, 0,00 € au pair), grands
montants (15 chiffres avant la virgule, sans perte). Propriétés : tout total
est un entier de centimes et `|arrondi − exact| ≤ 0,5 centime` ;
`toCents(−x) = −toCents(x)`.

## 8. Dérogations et double validation

`PriceOverride { id, lineId, unitPrice, validFrom, validTo, reason, authorId, approvedBy? }`
remplace le **prix unitaire calculé** d'une ligne sur `[validFrom, validTo]`
(bornes incluses, toujours bornée).

- **Motif obligatoire** : vide → jamais appliquée (`EMPTY_REASON`).
- **Écart** = |prix dérogé − prix calculé| / prix calculé × 100, calculé **à
  la date** (après révision). Au-delà **strictement** du seuil
  `overrideApprovalThresholdPercent` (défaut 10 %), la dérogation exige
  `approvedBy` **distinct** de `authorId`. Prix calculé nul → écart infini →
  double validation.
- Non conforme → **ignorée** par `priceAt` et listée dans la trace
  (`OVERRIDE_SKIPPED` : `REQUIRES_SECOND_APPROVAL`, `SELF_APPROVAL`,
  `EMPTY_REASON`, `SUPERSEDED`). Le barème reste calculable ; la dérogation en
  attente n'est jamais appliquée « en attendant ».
- Plusieurs dérogations éligibles : la plus récente (`validFrom`) l'emporte,
  les autres sont `SUPERSEDED` ; égalité → `AMBIGUOUS_OVERRIDE`.
- Sur une ligne en paliers, la dérogation rend la ligne « plate » :
  prix dérogé × quantité.
- `validateOverride(o)` : contrôle à l'**écriture** (motif, période, auto-validation, format du prix).

`lineId` désigne `PricingLine.id` : la couche persistance doit garder un
identifiant de ligne **stable d'une version de barème à l'autre** pour qu'une
dérogation survive à une révision.

## 9. Quantités et fournisseurs

```ts
interface QuantityProvider {
  getQuantity(contractRef: string, articleCode: string, date: string):
    Promise<{ quantity: string; source: string; observedAt: string | null }>;
}
```

- Une ligne `quantity: { source: 'PROVIDER', articleCode? }` est résolue par
  `resolveQuantities(input, contractRef, date, provider)` **avant** `priceAt`
  (qui reste synchrone et pur). Appels séquentiels, dans l'ordre du barème.
- Le fournisseur **doit rejeter** si la quantité est inconnue (jamais de 0
  implicite) ; `priceAt` sans quantité résolue → `MISSING_QUANTITY`.
- Provenance et instant d'observation sont reportés dans la trace (`QUANTITY`).
- `FakeQuantityProvider` : implémentation en mémoire (entrée la plus récente
  dont `effectiveFrom ≤ date`), journalise ses appels ; sert aux tests, à la
  démonstration et au simulateur.

**Branchement réel (RMM de Client Help) — documenté, non supposé.** L'API du
RMM n'est pas connue à ce jour. Le branchement consistera à écrire, dans
`apps/api` (et non dans `@lsi/pricing`), un adaptateur
`ClientHelpRmmQuantityProvider implements QuantityProvider` qui :

1. traduit `contractRef` en identifiant client Client Help (via
   `Customer.externalRef`) et `articleCode` en métrique RMM (table de
   correspondance paramétrable par tenant, ex. `POSTE → endpoints.managed`) ;
2. interroge l'API du RMM avec un compte de service (clé en secret Docker),
   délai d'expiration court, sans nouvelle tentative silencieuse ;
3. renvoie `source: 'rmm:client-help'` et l'instant de mesure fourni par le
   RMM ; **rejette** (`QUANTITY_UNAVAILABLE`) si la mesure manque ou date de
   plus de N jours (N paramétrable) ;
4. est couvert par des tests sur fixtures JSON capturées
   (`test/fixtures/rmm/`), cas d'erreur compris — aucun appel réseau en test.

Recommandation : **figer** chaque quantité résolue (table d'observations) au
moment de la facturation, pour que `priceAt` d'une date passée rejoue la
quantité effectivement facturée et non la mesure du jour.

## 10. Trace de calcul

Chaque ligne porte `trace: TraceStep[]`, étapes **dans l'ordre d'exécution**,
toutes les valeurs en chaînes (JSON direct). Types : `QUANTITY`, `BASE_PRICE`,
`RULE_PRICE`, `TIERS` (tranches détaillées), `INDEX`, `FORMULA` (texte et
valeur de chaque variable), `REVISION` (P0, a, b, S0/S1 avec période, valeur
et date de publication, ratio, coefficient, résultat),
`REVISION_NOT_EFFECTIVE`, `ADJUSTMENT` (règle, seuil, %, avant/après),
`ROUNDING` (cible, exact, arrondi, échelle, mode), `OVERRIDE_APPLIED` (motif,
auteur, validateur, écart), `OVERRIDE_SKIPPED` (raison), `HOUR_PACK`,
`DISCOUNT`, `LINE_TOTAL`.

Exemple (§6.3, abrégé) :

```json
[
  { "type": "QUANTITY", "source": "FIXED", "quantity": "1", "observedAt": null },
  { "type": "BASE_PRICE", "mode": "MANUAL", "unitPrice": "1250" },
  { "type": "REVISION", "formula": "P1 = P0 × (a + b × S1 / S0)", "appliesTo": "UNIT_PRICE",
    "P0": "1250", "a": "0.15", "b": "0.85",
    "S0": { "indexCode": "SYNTEC", "period": "2025-07", "value": "321.5", "publishedAt": "2025-08-27",
            "requestedDate": "2025-09-15", "rule": "LATEST_PUBLISHED", "indexName": "…" },
    "S1": { "indexCode": "SYNTEC", "period": "2026-07", "value": "333.2", "…": "…" },
    "ratio": "1.036391912908242612752721617418351477449",
    "coefficient": "1.030933125972006220839813374805598755832",
    "result": "1288.66640746500777604976671850699844479" },
  { "type": "ROUNDING", "target": "UNIT_PRICE", "exact": "1288.66640746500777604976671850699844479", "rounded": "1288.666407", "scale": 6, "mode": "HALF_AWAY_FROM_ZERO" },
  { "type": "LINE_TOTAL", "unitPrice": "1288.666407", "quantity": "1", "exact": "1288.666407" },
  { "type": "ROUNDING", "target": "LINE_TOTAL", "exact": "1288.666407", "rounded": "1288.67", "scale": 2, "mode": "HALF_AWAY_FROM_ZERO" }
]
```

Objectif : refaire le calcul à la main à partir de la trace seule et
retomber au centime.

## 11. Résultat

`priceAt(input, date): PricingResult` :

- `date`, `scheduleId`, `scheduleValidFrom/To`, `currency`, `settings` (résolus) ;
- `lines[]` (ordre du barème) : `lineId, code, label, unit, kind, mode,
  recurrence, quantity, unitPrice, vatRatePercent, totalHtCents, trace` ;
- `totals` : `htCents`, `vatCents`, `ttcCents`, `vatByRate[]` (triés par taux :
  `ratePercent, baseHtCents, vatCents`), `monthlyLinesCents`,
  `yearlyLinesCents`, `oneOffCents`, **`monthlyRecurringCents`** = mensuel +
  annuel / 12 (arrondi une fois), `annualRecurringCents` = mensuel × 12 + annuel.

Le **chiffre d'affaires récurrent contractualisé** d'un contrat est
`monthlyRecurringCents` (HT) ; les lignes ponctuelles (mise en service, régie,
packs) en sont exclues.

## 12. Simulateur

`simulate(input, date, changes, { beforeDate? })` → `{ before, after, lineDeltas[], totalsDelta }`.
Changements : `indexValues` (valeurs hypothétiques ; `publishedAt` par défaut
= 1er jour de la période), `quantities` (tracées `source: 'simulation'`),
`linePrices` (nouveau prix de **base** ; la révision et les dérogations
continuent de s'appliquer ; refusé sur paliers et remises). Le simulateur n'a
aucune règle propre : il appelle `priceAt` deux fois sur des copies — le prix
simulé est exactement celui qui serait facturé. `beforeDate` compare deux
dates (prix actuel vs après la prochaine révision).

## 13. Intégration : `priceAt(contractId, date)`

La signature du brief est celle de la couche applicative ; elle compose
(esquisse — `loadPricingSnapshot` et `stripTrace` restent à écrire dans la
couche persistance / API) :

```ts
async function contractPriceAt(scope, contractId: string, date: string, opts) {
  // 1. Charger l'instantané, sous withScope() (RLS tenant + client) :
  const snapshot = await withScope(scope, (tx) => loadPricingSnapshot(tx, contractId));
  //    { schedules (toutes versions), indexes (séries référencées),
  //      overrides (de la ligne, non supprimées), ruleCatalog (version tenant),
  //      settings (paramètres tenant pricing.*), context (commitmentMonths) }
  // 2. Résoudre les quantités (E/S, hors transaction) :
  const quantities = await resolveQuantities(snapshot, contract.externalRef, date, quantityProvider);
  // 3. Calcul pur :
  const result = priceAt({ ...snapshot, quantities }, date);
  // 4. Sérialiser pour l'API (bigint → chaîne), trace si ?trace=true :
  return toJsonSafe(opts.trace ? result : stripTrace(result));
}
```

Correspondance Prisma prévue (tables du lot tarification) : `PricingSchedule`
→ `PricingSchedule` ; `PricingLine` (colonnes typées + JSON pour `tiers`,
`rule`, `formula`, `revision`, `discount`) ; `PriceIndex`/`PriceIndexValue` ;
`PriceOverride` ; montants `Decimal(20,6)` convertis en chaîne par
`Decimal.toFixed()` (jamais via `number`). Les erreurs `PricingError` se
traduisent en `application/problem+json` (RFC 9457) : `type` dérivé du `code`,
`detail` = message, extensions = `details` (`lineId`, `position`…) ;
`INVALID_*` / `FORMULA_*` → 422, `NO_SCHEDULE` → 404,
`INDEX_VALUE_NOT_FOUND` / `MISSING_QUANTITY` / `QUANTITY_UNAVAILABLE` → 409.

`POST /api/v1/pricing/quote` construit un barème éphémère d'une ligne (article
du catalogue du tenant, quantité, date) et appelle le même `priceAt`.

## 14. Codes d'erreur

| Code | Cause |
|---|---|
| `INVALID_DECIMAL`, `INVALID_DATE` | format d'entrée |
| `INVALID_LINE` | ligne incohérente (champ manquant, combinaison type × mode, paliers invalides…) ; `details.lineId` |
| `INVALID_SETTINGS` | paramètres tenant, devise ≠ EUR |
| `NO_SCHEDULE`, `OVERLAPPING_SCHEDULES` | versions de barème |
| `MISSING_QUANTITY`, `QUANTITY_UNAVAILABLE` | quantités fournies |
| `MISSING_CONTEXT` | remise d'engagement sans durée |
| `RULE_NOT_FOUND` | règle ou entrée de grille absente |
| `NEGATIVE_PRICE` | formule négative |
| `INDEX_NOT_FOUND`, `INDEX_VALUE_NOT_FOUND`, `DUPLICATE_INDEX_VALUE` | indices |
| `INVALID_REVISION_COEFFICIENTS` | a + b ≠ 1, coefficient négatif |
| `AMBIGUOUS_OVERRIDE` | deux dérogations éligibles de même début |
| `DISCOUNT_TARGET_MISMATCH`, `DISCOUNT_EXCEEDS_BASE` | remises |
| `FORMULA_*`, `DIVISION_BY_ZERO` | formules (`FormulaError`, avec `position`) |

Toute erreur levée pendant le calcul d'une ligne porte `details.lineId`.

## 15. Tests

`pnpm --filter @lsi/pricing test` — unitaires par module, exemples chiffrés
de ce document assertés à l'identique, et propriétés fast-check :
monotonie GRADUATED (exacte et arrondie), non-monotonie VOLUME documentée et
monotonie intra-palier, prix moyen décroissant ; arrondi (entier, écart
≤ 0,5 centime, symétrie) ; TVA ; idempotence et non-mutation de `priceAt` sur
entrée gelée ; révision (a = 1, b = 0 → P0 ; S1 = S0 → P0 ; indice en hausse →
prix non décroissant). Aucun appel réseau.

## 16. Hypothèses (à reporter dans `00-architecture.md` §6)

| # | Hypothèse | Justification | Impact si fausse |
|---|---|---|---|
| V2-H17 | Prix unitaire calculé (révision, formule, règles) arrondi à **6 décimales** par défaut (`unitPriceScale`), puis total de ligne au centime. | fidélité maximale à la formule ; précision de stockage | paramètre tenant `unitPriceScale = 2` (écart possible de quelques centimes, §6.4) |
| V2-H18 | Recherche d'indice par défaut `LATEST_PUBLISHED` (dernier indice publié à la date), `EXACT_PERIOD` activable par tenant ou par ligne. | rejouabilité ; pratique Syntec « dernier indice connu » | changer `indexLookup` |
| V2-H19 | Seuil de double validation des dérogations : **10 %** d'écart par défaut, comparaison stricte, sur le prix calculé à la date. | brief « seuil paramétrable » sans valeur | paramètre tenant |
| V2-H20 | Une remise porte sur des lignes de **même taux de TVA et même récurrence** ; pas de ventilation automatique. | décision comptable laissée à l'utilisateur | ajout d'une ventilation au prorata |
| V2-H21 | Récurrences par défaut : `UNIT`/`TIERED` mensuelles, `HOURLY`/`HOUR_PACK` ponctuelles (à l'usage). | usage MSP courant | champ `recurrence` sur la ligne |
| V2-H22 | Les dates du moteur sont des dates **calendaires** (pas d'instant) ; la conversion `Europe/Paris` se fait à la frontière API. | aucun fuseau dans une règle de prix | — |
| V2-H23 | Une valeur d'indice simulée sans date de publication est réputée publiée le 1er jour de sa période. | permet de simuler une révision à venir | préciser `publishedAt` |

Reportées dans `00-architecture.md` §6 avec celles du lot 3 (§17.9).

## 17. Persistance et API (lot 3)

Le moteur reste pur ; `apps/api/src/pricing/` le branche sur la base.
Migration `00000000000021_tarification`, services, API interne `/v1`.

### 17.1 Tables (migration 21)

| Table | Classe | Rôle et garanties portées par la base |
|---|---|---|
| `price_indexes` | tenant | série d'indice (`code` unique par tenant, `connector` JSON sans secret) ; pas de DELETE |
| `price_index_values` | tenant | valeur (période `YYYY-MM`, `numeric(18,6)`, `published_at`, source `MANUAL`/`IMPORT`) ; **append-only** (UPDATE/DELETE révoqués) ; correction = nouvelle ligne `supersedes_id` + motif : UNIQUE (série, période, révision), UNIQUE (`supersedes_id`), FK composite « même série, même période » → l'historique est une **chaîne** ; la valeur retenue est sa pointe |
| `pricing_rules` | tenant | catalogue (`code` = `id` de règle du moteur, `type`, `definition` JSON) ; interne ; archivage au lieu de DELETE |
| `pricing_schedules` | customer | version (contrat, n°) `DRAFT` → `ACTIVE` → `SUPERSEDED` ; **EXCLUDE gist** `(contract_id =, daterange &&)` sur les versions non DRAFT : deux versions engagées ne couvrent jamais un même jour ; trigger : une version engagée est immuable, sauf sa **clôture** (SUPERSEDED, fin de validité posée ou avancée) ; `commitment_months` (remises d'engagement) |
| `pricing_lines` | customer | colonnes typées (`article_code`, `kind`, `mode`, `vat_rate_percent`, `quantity` / `quantity_source`, `unit_price numeric(20,6)`) + `params` JSON (`tiers`, `rule`, `formula`, `revision`, `hourPack`, `discount` — types du moteur) ; **`line_key` stable** entre versions = `lineId` du moteur ; trigger : lignes figées avec leur version |
| `price_overrides` | customer | dérogation bornée (`valid_to` NOT NULL), motif non vide, `line_key` ; **CHECK `approved_by_user_id <> author_user_id`** (idem pour le refus) ; CHECK statut ↔ validation ; prix, période, motif, auteur figés (GRANT UPDATE limité aux colonnes de décision) ; pas de DELETE |

RLS `ENABLE` + `FORCE` + politique `TO lsi_app` (`USING` + `WITH CHECK`) sur
les six tables. Le portail client pourra **lire** barème, lignes et indices de
ses contrats (écriture interne seulement) ; règles et dérogations sont
internes (grilles de tous les clients, motifs). Un calcul pour le portail
passera par un scope SYSTEM borné au client.

### 17.2 `priceAt(contractId, date)` et sa réponse

`PricingService` : instantané sous `withScope` (versions engagées, lignes,
indices référencés repliés à la pointe de chaîne, dérogations ACTIVE,
catalogue, paramètres `pricing.*` via `TenantConfigService`) →
`resolveQuantities` (hors transaction) → `priceAt` du moteur → `toJsonSafe`.

`GET /v1/contracts/{id}/pricing?at=YYYY-MM-DD&trace=true&version=N` (`at` par
défaut : aujourd'hui à Paris ; `version` prévisualise une seule version,
brouillon compris) :

```json
{
  "contractId": "…", "date": "2026-09-15", "scheduleId": "…", "scheduleVersion": 1,
  "scheduleValidFrom": "2025-09-15", "scheduleValidTo": null, "currency": "EUR",
  "settings": { "rounding": "HALF_AWAY_FROM_ZERO", "unitPriceScale": 6, "overrideApprovalThresholdPercent": "10", "indexLookup": "LATEST_PUBLISHED" },
  "lines": [{ "lineId": "infogerance", "code": "INFOG", "label": "…", "unit": "mois", "kind": "FLAT_MONTHLY",
              "mode": "MANUAL", "recurrence": "MONTHLY", "quantity": "1", "unitPrice": "1288.666407",
              "vatRatePercent": "20", "totalHtCents": "128867", "trace": ["…"] }],
  "totals": { "htCents": "128867", "vatCents": "25773", "ttcCents": "154640", "vatByRate": ["…"],
              "monthlyRecurringCents": "128867", "annualRecurringCents": "1546404" },
  "pendingOverrides": []
}
```

**Monnaie en JSON** : prix unitaires en chaînes décimales (euros, au moins
`unitPriceScale` décimales : `"1250.000000"`) ; totaux en **chaînes d'entiers
de centimes**. Jamais de nombre JSON pour de la monnaie. Sans `trace=true`,
les lignes n'ont pas de `trace`. L'exemple §6.3 est asserté à l'identique sur
HTTP (`apps/api/tests/isolation/pricing.test.ts`).

Erreurs du moteur → corps RFC 9457 (`type` `urn:lsi:contrats:pricing:<code>`,
`title`, `status`, `detail`) + `code` et `details` : `NO_SCHEDULE` 404 ;
`INDEX_*`, `MISSING_QUANTITY`, `QUANTITY_UNAVAILABLE`, `RULE_NOT_FOUND` 409 ;
le reste 422.

### 17.3 Dérogations : flux de double validation

1. `POST …/pricing/overrides` (`pricing.write`) : motif, période bornée, prix
   (règles `validateOverride` du moteur). La ligne doit exister à `validFrom`.
   Prix de référence = prix calculé **sans dérogation** à `validFrom` ; écart
   comparé **strictement** au seuil `pricing.overrideApprovalThresholdPercent`
   (défaut 10). Sous le seuil : `ACTIVE` (+ `pricing.revised`) ; au-delà :
   `PENDING_APPROVAL`.
2. `…/overrides/{oid}/approve` (`pricing.override.approve`, admin) par un
   utilisateur **distinct de l'auteur** (403 sinon ; CHECK en base) →
   `ACTIVE`. Mise à jour conditionnelle : deux validations concurrentes → 409.
3. `…/reject` (motif obligatoire) → `REJECTED` ; `…/cancel` (`pricing.write`) → `CANCELLED`.

Au calcul, une dérogation `PENDING_APPROVAL` n'est **jamais** transmise au
moteur (V2-H29) ; elle figure dans la trace de la ligne (`OVERRIDE_SKIPPED`,
`REQUIRES_SECOND_APPROVAL`) et dans `pendingOverrides`. Une dérogation
`ACTIVE` sans validateur dont l'écart dépasse le seuil à une date ultérieure
(après révision) est écartée par le moteur avec la même trace ; elle peut
alors être validée.

### 17.4 Quantités : brancher un vrai `QuantityProvider`

Jeton `QUANTITY_PROVIDER` (`apps/api/src/pricing/quantity-provider.ts`) ; le
service dépend du port du moteur. Défaut : `ManualQuantityProvider` (les
lignes `FIXED` portent leur quantité ; une ligne `PROVIDER` sans connecteur →
409 `QUANTITY_UNAVAILABLE`, jamais 0). `contractRef` = **id du contrat**.
Pour le RMM de Client Help (§9) : écrire `ClientHelpRmmQuantityProvider`
dans `apps/api/src/pricing/`, qui résout `contractRef` → `Customer.externalRef`
par une lecture `withScope(systemScope(…))`, et le déclarer dans
`app.module.ts` (`{ provide: QUANTITY_PROVIDER, useClass: … }`, conditionné à
la présence de sa clé, comme les autres adaptateurs). Tests :
`overrideProvider(QUANTITY_PROVIDER)` + fixtures JSON, sans réseau. Rien de
l'API du RMM n'est supposé ici.

### 17.5 Indices et connecteur d'import

- Saisie : `POST /v1/price-indexes/{code}/values` `{ period, value, publishedAt }` ;
  période déjà publiée → 409 `PERIOD_ALREADY_PUBLISHED`. Correction :
  `{ …, supersedesId, correctionReason }` sur la valeur **courante** (sinon 409).
- Import : `POST /v1/price-indexes/{code}/values/import`, multipart `file`.
  Port `IndexConnector` (`index-connector.ts`), registre `INDEX_CONNECTORS`,
  choisi par `price_indexes.connector.type` (défaut `CSV`). `CsvIndexConnector` :
  `period;value[;publishedAt]`, séparateur et virgule décimale paramétrables,
  en-tête, commentaires et BOM tolérés, ≤ 1 000 lignes. **Tout ou rien** : une
  ligne invalide, un doublon dans le fichier ou une valeur contredisant une
  période publiée → 422 `INVALID_IMPORT` avec erreurs numérotées, rien n'est
  écrit ; une valeur identique à l'existant est ignorée (ré-import idempotent).
  Aucun connecteur n'ouvre le réseau ; un connecteur INSEE s'ajouterait au
  registre sans toucher au service.

### 17.6 API interne — récapitulatif

| Méthode | Chemin | Droit |
|---|---|---|
| GET | `/v1/contracts/{id}/pricing/schedules` (+ `nextRevisionDate`) | `contracts.read` |
| POST | `/v1/contracts/{id}/pricing/schedules` (brouillon : `lines` ou `copyFromVersion`) | `pricing.write` |
| PUT, DELETE | `/v1/contracts/{id}/pricing/schedules/{n}` (brouillon seulement, sinon 409) | `pricing.write` |
| POST | `/v1/contracts/{id}/pricing/schedules/{n}/activate` | `pricing.write` |
| GET | `/v1/contracts/{id}/pricing?at=&trace=&version=` | `contracts.read` |
| POST | `/v1/contracts/{id}/pricing/simulate` `{ at, beforeDate?, changes, trace? }` | `pricing.simulate` |
| POST | `/v1/pricing/quote` `{ contractId? \| customerId?, articleCode, quantity, date?, ruleCode? }` | `pricing.simulate` |
| GET, POST | `/v1/contracts/{id}/pricing/overrides` | `contracts.read`, `pricing.write` |
| POST | `…/overrides/{oid}/approve`, `…/reject` | `pricing.override.approve` |
| POST | `…/overrides/{oid}/cancel` | `pricing.write` |
| GET, POST | `/v1/price-indexes`, `/v1/price-indexes/{code}/values`, `…/values/import` | `contracts.read`, `pricing.indexes.manage` |
| GET, POST, PUT | `/v1/pricing-rules`, `/v1/pricing-rules/{code}`, `…/{code}/archive` | `contracts.read`, `pricing.rules.manage` |

Activation d'une version : le moteur la calcule à sa date d'effet (erreur
structurelle → 422, ex. `FORMULA_SYNTAX`) ; les versions engagées antérieures
qui la chevauchent sont clôturées la veille (SUPERSEDED) ; une version engagée
commençant le même jour ou après → 409 `SCHEDULE_OVERLAP` ; une course est
tranchée par la contrainte d'exclusion (409). Puis `pricing.revised` et
recalcul de l'échéancier.

Catalogue : `definition` validée par type (champs de `PricingRule`) ; pas de
suppression, archivage (la règle reste résoluble pour les barèmes qui la citent).

Devis : le barème du contrat fait foi s'il porte l'article (contrat désigné,
ou **unique** contrat du client portant l'article à la date — plusieurs →
409) ; sinon la grille GRID du catalogue (plusieurs → 409, préciser
`ruleCode`). La future route publique `POST /api/v1/pricing/quote` appellera
ce service.

### 17.7 Événement `pricing.revised` et échéancier

`PricingEvents.publish` (après commit) : entrée `pricing.revised` dans la
piste d'audit chaînée (source durable pour le lot webhooks) + abonnés
`onPricingRevised(listener)`, point de branchement du dispatcher de webhooks
sortants. Causes : `SCHEDULE_ACTIVATED`, `OVERRIDE_EFFECTIVE`,
`OVERRIDE_CANCELLED`. Les mutations HTTP restent auditées par l'`AuditInterceptor`.

`DeadlinesService.nextRevision` appelle `PricingService.nextRevisionDate` :
date de révision à venir des versions engagées en vigueur ; une fois passée,
sur une version sans fin, l'anniversaire suivant (V2-H24) → échéance
`PRICE_REVISION` et ses alertes.

### 17.8 Hypothèses du lot 3

| # | Hypothèse | Impact si fausse |
|---|---|---|
| V2-H24 | Révision annuelle : une date de révision passée, sur une version sans fin, annonce la suivante à la date anniversaire. | périodicité par ligne |
| V2-H25 | Import d'indice sans date de publication : publiée le jour de l'import (seule date certaine). Pour une reprise d'historique, fournir la 3ᵉ colonne. | — |
| V2-H26 | Devis catalogue sans taux précisé : TVA 20 %. | passer `vatRatePercent` |
| V2-H27 | Le catalogue de règles est l'état courant : modifier une grille modifie le prix des lignes RULE qui la citent, à toute date. Figer = ligne MANUAL ou une grille par millésime. | versionner le catalogue |
| V2-H28 | Une correction de valeur d'indice vaut rétroactivement (erratum), y compris pour rejouer une date passée. | rejouer « tel que connu à la date » |
| V2-H29 | Une dérogation EN ATTENTE n'est jamais appliquée, même si l'écart à la date retombe sous le seuil. | la transmettre au moteur |

## 18. Récurrence trimestrielle et tableau de prix des propositions (lot 9)

### 18.1 `QUARTERLY`

`Recurrence` accepte `QUARTERLY` (prestations trimestrielles : test de
restauration avec procès-verbal). Totaux : `quarterlyLinesCents` ;
`monthlyRecurringCents` = mensuel + arrondi(trimestriel / 3 + annuel / 12) ;
`annualRecurringCents` = mensuel × 12 + trimestriel × 4 + annuel. Sans ligne
trimestrielle, les résultats sont **identiques** à ceux d'avant (tests
existants inchangés). `pricing_lines.recurrence` accepte la valeur
(migration 30). Hypothèse V2-H48.

### 18.2 `quoteProposal` (`src/proposal.ts`)

Le tableau de prix d'une proposition (forme de l'annexe C) est **configuré**
(inclusions, quantités, bornes, règles de dépendance — aucun montant) puis
**calculé par `priceAt`** : chaque ligne retenue devient une `PricingLine`
`MANUAL` (prix unitaire du modèle, centimes → euros), une règle
`DISCOUNT_PERCENT` une ligne `DISCOUNT` (pourcentage sur les lignes ciblées,
arrondi du moteur), le minimum mensuel une ligne `FLAT_MONTHLY` de complément
ajoutée puis recalculée (V2-H49). Ventilation par récurrence avec
`computeTotals` ; total sur la durée = mensuel × mois + trimestriel ×
(mois / 3) + annuel × (mois / 12), TVA = somme des TVA de période (V2-H50).

Le **barème produit** (`engineSchedule`) est figé à l'acceptation
(`pricing_snapshots`) puis écrit **tel quel** comme version 1 du barème du
contrat (`11-propositions.md` §10) : prix affiché = prix figé = barème initial.

### 18.3 Même résultat que la référence de l'annexe C

`packages/persistence/test/seed/proposal-templates.engine.test.ts` confronte
`quoteProposal` aux cas de contrôle chiffrés des quatre modèles livrés
(`runControlCases` vide), ainsi qu'aux choix présélectionnés, erreurs et
éléments « à valider » de la spécification `reference-pricing.ts`.

Exemples (brief §12.11) : infogérance 50 postes, 2 serveurs, 5 équipements
réseau → **1 515,00 € HT / mois** sur 24 mois (36 360,00 €), **1 362,50 €**
sur 36 mois (49 050,00 €), **2 300,00 €** de mise en service ; RSSI TPE-PME +
DPO → (1 200 + 350) × 0,90 = **1 395,00 €** ; ETI + DPO → **6 885,00 €** ;
sauvegarde en ligne 2 postes + 1 To sur 12 mois → 45,00 € calculés,
**49,00 €** après minimum.
