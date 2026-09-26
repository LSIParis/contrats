import type { RoundingMode } from './money.js';

/**
 * Modèle de données d'ENTRÉE du moteur : un instantané, pas des entités.
 *
 * Ces types sont volontairement « plats » et sérialisables en JSON (chaînes
 * décimales, dates « YYYY-MM-DD », aucun objet Date, aucun bigint) : la couche
 * persistance les construit depuis Prisma, l'API publique peut les recevoir
 * tels quels pour un devis, et un test les écrit à la main.
 *
 * Conventions :
 *  - Montant saisi (prix unitaire, montant de remise) : chaîne décimale en
 *    euros, au plus 6 décimales (stockage Decimal(20,6)) — « 0.0125 ».
 *  - Pourcentage : chaîne décimale (« 20 », « 5.5 », « 12.5 »).
 *  - Quantité : chaîne décimale positive, au plus 6 décimales (1.5 heure).
 *  - Date : « YYYY-MM-DD », bornes INCLUSES ([validFrom, validTo]).
 *  - Période d'indice : « YYYY-MM ».
 *
 * Les champs optionnels propres à un type de ligne (tiers, discount…) sont
 * validés à l'exécution avec une erreur INVALID_LINE nommant la ligne : un
 * barème stocké en base peut être incohérent, le moteur le dit au lieu de
 * « faire au mieux ».
 */

// ---------------------------------------------------------------------------
// Barème
// ---------------------------------------------------------------------------

/**
 * Type de ligne (QUOI est facturé) :
 *  - FLAT_MONTHLY : forfait mensuel (récurrence mensuelle imposée) ;
 *  - FLAT_YEARLY  : forfait annuel (récurrence annuelle imposée) ;
 *  - UNIT         : prix unitaire × quantité (poste, serveur, utilisateur,
 *                   licence, site, équipement supervisé…) ;
 *  - HOURLY       : taux horaire × heures ;
 *  - HOUR_PACK    : prix d'un pack × nombre de packs (`hourPack.hoursPerPack`
 *                   heures par pack, pour la trace du taux horaire effectif) ;
 *  - SETUP_FEE    : frais de mise en service, ponctuels (récurrence imposée) ;
 *  - TIERED       : paliers (GRADUATED ou VOLUME, voir tiers.ts) ;
 *  - DISCOUNT     : remise en pourcentage ou en montant sur d'autres lignes
 *                   ou sur le sous-total.
 */
export type LineKind =
  | 'FLAT_MONTHLY'
  | 'FLAT_YEARLY'
  | 'UNIT'
  | 'HOURLY'
  | 'HOUR_PACK'
  | 'SETUP_FEE'
  | 'TIERED'
  | 'DISCOUNT';

/**
 * Mode de détermination du prix (COMMENT il est obtenu) :
 *  - RULE    : depuis le catalogue de règles du tenant (grille, paliers,
 *              remise volume, remise d'engagement) ;
 *  - FORMULA : expression déclarative (formula/*) ;
 *  - MANUAL  : prix unitaire (ou paliers) saisi sur la ligne.
 * La dérogation ponctuelle (PriceOverride) n'est pas un mode : elle se
 * superpose, bornée dans le temps, à n'importe lequel des trois.
 */
export type PricingMode = 'RULE' | 'FORMULA' | 'MANUAL';

/** Périodicité de facturation. Sert à la ventilation récurrent / ponctuel. */
export type Recurrence = 'MONTHLY' | 'YEARLY' | 'ONE_OFF';

export type TierMode = 'GRADUATED' | 'VOLUME';

export interface Tier {
  /** Borne haute INCLUSE du palier ; `null` = illimité (dernier palier seulement). */
  readonly upTo: string | null;
  readonly unitPrice: string;
}

export interface TierTable {
  readonly mode: TierMode;
  readonly tiers: readonly Tier[];
}

export type QuantitySpec =
  /** Quantité saisie sur le barème. */
  | { readonly source: 'FIXED'; readonly value: string }
  /**
   * Quantité remontée par un QuantityProvider (RMM…), résolue AVANT priceAt
   * (voir quantity.ts) et passée dans `PricingInput.quantities`.
   * `articleCode` : code article côté fournisseur (défaut : `line.code`).
   */
  | { readonly source: 'PROVIDER'; readonly articleCode?: string };

export type IndexLookupRule = 'LATEST_PUBLISHED' | 'EXACT_PERIOD';

/**
 * Révision native P1 = P0 × (a + b × S1 / S0), avec a + b = 1.
 * S0 = indice à `referenceDate`, S1 = indice à `revisionDate`. La révision ne
 * s'applique qu'à partir de `revisionDate` (incluse) ; avant, le prix est P0.
 * Chaque révision annuelle est en pratique une nouvelle version de barème
 * (validFrom = date de révision) qui conserve P0 et la date de référence.
 */
export interface RevisionSpec {
  readonly indexCode: string;
  readonly a: string;
  readonly b: string;
  readonly referenceDate: string;
  readonly revisionDate: string;
  /** Défaut : `settings.indexLookup`. */
  readonly lookup?: IndexLookupRule;
}

/** Liaison d'une variable de formule à une valeur d'indice. */
export interface IndexBinding {
  readonly indexCode: string;
  /** Date calendaire, ou `PRICING_DATE` pour la date du calcul. */
  readonly date: string;
  readonly lookup?: IndexLookupRule;
}

export interface FormulaSpec {
  /** Expression dont le résultat est le PRIX UNITAIRE HT en euros. */
  readonly expression: string;
  /** Prix de base, exposé sous le nom `P0`. */
  readonly basePrice?: string;
  /** Constantes nommées (chaînes décimales, négatifs admis). */
  readonly variables?: Readonly<Record<string, string>>;
  /** Variables liées à des indices (ex. { S0: {...}, S1: {...} }). */
  readonly indexVariables?: Readonly<Record<string, IndexBinding>>;
}

export interface RuleRef {
  /** Règle donnant le prix : GRID (par code article) ou TIERS. */
  readonly priceRuleId: string;
  /** Règles d'ajustement appliquées ensuite, dans l'ordre : VOLUME_DISCOUNT, COMMITMENT_DISCOUNT. */
  readonly adjustmentRuleIds?: readonly string[];
}

export type DiscountTarget = { readonly scope: 'LINES'; readonly lineIds: readonly string[] } | { readonly scope: 'SUBTOTAL' };

export interface DiscountSpec {
  readonly type: 'PERCENT' | 'AMOUNT';
  /** Pourcentage (0–100) ou montant HT positif en euros ; la ligne produite est négative. */
  readonly value: string;
  readonly appliesTo: DiscountTarget;
}

export interface PricingLine {
  readonly id: string;
  /** Code article (clé des grilles et des fournisseurs de quantités). */
  readonly code: string;
  readonly label: string;
  /** Unité affichée : « mois », « poste », « serveur », « heure », « pack »… */
  readonly unit: string;
  readonly kind: LineKind;
  readonly mode: PricingMode;
  readonly vatRatePercent: string;
  /** Défaut : FIXED 1. Sans objet pour DISCOUNT. */
  readonly quantity?: QuantitySpec;
  /** Défaut selon `kind` ; imposée pour FLAT_MONTHLY, FLAT_YEARLY, SETUP_FEE ; déduite des cibles pour DISCOUNT. */
  readonly recurrence?: Recurrence;
  /** MANUAL (hors TIERED/DISCOUNT) : prix unitaire HT. */
  readonly unitPrice?: string;
  /** MANUAL + TIERED : table de paliers. */
  readonly tiers?: TierTable;
  /** RULE. */
  readonly rule?: RuleRef;
  /** FORMULA. */
  readonly formula?: FormulaSpec;
  /** MANUAL ou RULE : révision indicielle native. */
  readonly revision?: RevisionSpec;
  /** HOUR_PACK. */
  readonly hourPack?: { readonly hoursPerPack: string };
  /** DISCOUNT. */
  readonly discount?: DiscountSpec;
}

export interface PricingSchedule {
  readonly id: string;
  readonly validFrom: string;
  /** Incluse ; `null` = sans fin. */
  readonly validTo: string | null;
  readonly currency: 'EUR';
  readonly lines: readonly PricingLine[];
}

// ---------------------------------------------------------------------------
// Catalogue de règles du tenant
// ---------------------------------------------------------------------------

export type PricingRule =
  | {
      readonly id: string;
      readonly type: 'GRID';
      readonly label?: string;
      readonly entries: readonly { readonly articleCode: string; readonly unitPrice: string }[];
    }
  | { readonly id: string; readonly type: 'TIERS'; readonly label?: string; readonly table: TierTable }
  | {
      readonly id: string;
      readonly type: 'VOLUME_DISCOUNT';
      readonly label?: string;
      /** Le seuil le plus élevé ≤ quantité s'applique. */
      readonly thresholds: readonly { readonly minQuantity: string; readonly percent: string }[];
    }
  | {
      readonly id: string;
      readonly type: 'COMMITMENT_DISCOUNT';
      readonly label?: string;
      /** Le seuil le plus élevé ≤ durée d'engagement (mois) s'applique. */
      readonly thresholds: readonly { readonly minMonths: number; readonly percent: string }[];
    };

export interface RuleCatalog {
  readonly rules: readonly PricingRule[];
}

// ---------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------

export interface PriceIndexValue {
  /** « YYYY-MM » */
  readonly period: string;
  /** Chaîne décimale (jusqu'à 10 décimales). */
  readonly value: string;
  /** Date de publication « YYYY-MM-DD ». */
  readonly publishedAt: string;
}

export interface PriceIndex {
  /** Ex. « SYNTEC ». */
  readonly code: string;
  readonly name: string;
  readonly values: readonly PriceIndexValue[];
}

// ---------------------------------------------------------------------------
// Dérogations
// ---------------------------------------------------------------------------

export interface PriceOverride {
  readonly id: string;
  readonly lineId: string;
  /** Prix unitaire HT dérogatoire, en euros. */
  readonly unitPrice: string;
  readonly validFrom: string;
  /** Incluse. Une dérogation est TOUJOURS bornée. */
  readonly validTo: string;
  /** Motif obligatoire (non vide). */
  readonly reason: string;
  readonly authorId: string;
  /** Second validateur, distinct de l'auteur ; requis au-delà du seuil d'écart. */
  readonly approvedBy?: string | null;
}

// ---------------------------------------------------------------------------
// Quantités résolues, paramètres, entrée
// ---------------------------------------------------------------------------

export interface ResolvedQuantity {
  readonly lineId: string;
  readonly quantity: string;
  /** Provenance lisible (« rmm:client-help », « fake »…). */
  readonly source: string;
  /** Instant d'observation ISO 8601, ou null. */
  readonly observedAt: string | null;
}

export interface PricingSettings {
  /** Défaut HALF_AWAY_FROM_ZERO (arrondi commercial). */
  readonly rounding: RoundingMode;
  /** Décimales du prix unitaire calculé (défaut 6 = précision de stockage). */
  readonly unitPriceScale: number;
  /** Écart (en %) au-delà duquel une dérogation exige une double validation (défaut 10). */
  readonly overrideApprovalThresholdPercent: string;
  /** Règle de recherche des valeurs d'indice par défaut (défaut LATEST_PUBLISHED). */
  readonly indexLookup: IndexLookupRule;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = Object.freeze({
  rounding: 'HALF_AWAY_FROM_ZERO',
  unitPriceScale: 6,
  overrideApprovalThresholdPercent: '10',
  indexLookup: 'LATEST_PUBLISHED',
});

export interface PricingContext {
  /** Durée d'engagement du contrat en mois (remises d'engagement). */
  readonly commitmentMonths?: number;
}

export interface PricingInput {
  /** Toutes les versions du barème ; celle valide à la date est retenue. */
  readonly schedules: readonly PricingSchedule[];
  readonly indexes?: readonly PriceIndex[];
  readonly overrides?: readonly PriceOverride[];
  /** Quantités des lignes PROVIDER, résolues au préalable. */
  readonly quantities?: readonly ResolvedQuantity[];
  readonly ruleCatalog?: RuleCatalog;
  readonly settings?: Partial<PricingSettings>;
  readonly context?: PricingContext;
}
