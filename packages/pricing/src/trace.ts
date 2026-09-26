import type { IndexObservation } from './indexes.js';
import type { RoundingMode } from './money.js';
import type { OverrideSkipReason } from './overrides.js';
import type { TierBand } from './tiers.js';
import type { PricingMode, TierMode } from './types.js';

/**
 * Trace de calcul d'une ligne. (brief §5 « trace de calcul »)
 *
 * Une suite ORDONNÉE d'étapes, dans l'ordre exact où le moteur les a
 * exécutées. Chaque étape est un objet JSON simple (toutes les valeurs
 * numériques sont des chaînes décimales, les centimes aussi) : la trace
 * s'affiche telle quelle dans l'interface, se renvoie telle quelle par l'API
 * (`?trace=true`) et peut être archivée avec une facture.
 *
 * Objectif : qu'un contrôleur de gestion puisse refaire le calcul à la main,
 * à partir de la trace seule, et retomber au centime.
 */

export type TraceStep =
  | {
      readonly type: 'QUANTITY';
      /** « FIXED » (saisie au barème) ou provenance du fournisseur de quantités. */
      readonly source: string;
      readonly quantity: string;
      readonly observedAt: string | null;
    }
  | { readonly type: 'BASE_PRICE'; readonly mode: PricingMode; readonly unitPrice: string }
  | {
      readonly type: 'RULE_PRICE';
      readonly ruleId: string;
      readonly articleCode: string;
      readonly unitPrice: string;
    }
  | {
      readonly type: 'TIERS';
      readonly ruleId: string | null;
      readonly tierMode: TierMode;
      readonly bands: readonly TierBand[];
      readonly amount: string;
    }
  | { readonly type: 'INDEX'; readonly variable: string; readonly observation: IndexObservation }
  | {
      readonly type: 'FORMULA';
      readonly expression: string;
      readonly variables: Readonly<Record<string, string>>;
      readonly result: string;
    }
  | {
      readonly type: 'REVISION';
      readonly formula: 'P1 = P0 × (a + b × S1 / S0)';
      /** « UNIT_PRICE » (P0 = prix unitaire) ou « AMOUNT » (P0 = montant des paliers). */
      readonly appliesTo: 'UNIT_PRICE' | 'AMOUNT';
      readonly P0: string;
      readonly a: string;
      readonly b: string;
      readonly S0: IndexObservation;
      readonly S1: IndexObservation;
      readonly ratio: string;
      readonly coefficient: string;
      readonly result: string;
    }
  | { readonly type: 'REVISION_NOT_EFFECTIVE'; readonly revisionDate: string; readonly date: string }
  | {
      readonly type: 'ADJUSTMENT';
      readonly ruleId: string;
      readonly ruleType: 'VOLUME_DISCOUNT' | 'COMMITMENT_DISCOUNT';
      readonly basis: string;
      readonly threshold: string | null;
      readonly percent: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly type: 'ROUNDING';
      readonly target: 'UNIT_PRICE' | 'LINE_TOTAL' | 'AVERAGE_UNIT_PRICE';
      readonly exact: string;
      readonly rounded: string;
      /** Nombre de décimales en euros (2 = centime). */
      readonly scale: number;
      readonly mode: RoundingMode;
    }
  | {
      readonly type: 'OVERRIDE_APPLIED';
      readonly overrideId: string;
      readonly computedUnitPrice: string;
      readonly unitPrice: string;
      readonly validFrom: string;
      readonly validTo: string;
      readonly reason: string;
      readonly authorId: string;
      readonly approvedBy: string | null;
      readonly gapPercent: string | null;
      readonly requiresSecondApproval: boolean;
    }
  | {
      readonly type: 'OVERRIDE_SKIPPED';
      readonly overrideId: string;
      readonly reason: OverrideSkipReason;
      readonly gapPercent: string | null;
    }
  | { readonly type: 'HOUR_PACK'; readonly hoursPerPack: string; readonly effectiveHourlyRate: string }
  | {
      readonly type: 'DISCOUNT';
      readonly discountType: 'PERCENT' | 'AMOUNT';
      readonly value: string;
      readonly targetLineIds: readonly string[];
      readonly baseHtCents: string;
      readonly exact: string;
    }
  | { readonly type: 'LINE_TOTAL'; readonly unitPrice: string; readonly quantity: string; readonly exact: string };
