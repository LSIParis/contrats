import { PricingError } from './errors.js';
import { lookupIndexValue, type IndexObservation } from './indexes.js';
import { D, parseDecimal, parseIsoDate, type Decimal } from './money.js';
import type { IndexLookupRule, PriceIndex, RevisionSpec } from './types.js';

/**
 * Révision indicielle native : P1 = P0 × (a + b × S1 / S0).
 *
 *  - a : part fixe (non révisable), b : part indexée, a + b = 1 EXACTEMENT
 *    (égalité décimale, pas de tolérance : 0,15 + 0,85 passe, 0,15 + 0,8499
 *    est refusé — une clause de révision mal saisie doit se voir tout de suite) ;
 *  - a ≥ 0 et b ≥ 0 : une part négative n'a pas de sens contractuel ;
 *  - S0 : indice de référence (date de référence du contrat),
 *    S1 : indice à la date de révision.
 *
 * Ordre des opérations FIXÉ (et documenté, car il détermine les derniers
 * chiffres significatifs) :
 *   1. ratio       = S1 / S0
 *   2. coefficient = a + b × ratio
 *   3. P1 exact    = P0 × coefficient
 * Le prix unitaire exact est ensuite arrondi à `unitPriceScale` décimales par
 * priceAt, pas ici : cette fonction ne fait que de l'arithmétique exacte.
 */

export function assertRevisionCoefficients(a: Decimal, b: Decimal): void {
  if (a.isNegative() || b.isNegative()) {
    throw new PricingError('INVALID_REVISION_COEFFICIENTS', `Révision : a (${a.toString()}) et b (${b.toString()}) doivent être positifs ou nuls.`, {
      a: a.toString(),
      b: b.toString(),
    });
  }
  if (!a.plus(b).eq(1)) {
    throw new PricingError(
      'INVALID_REVISION_COEFFICIENTS',
      `Révision : a + b doit valoir exactement 1 (a = ${a.toString()}, b = ${b.toString()}, a + b = ${a.plus(b).toString()}).`,
      { a: a.toString(), b: b.toString() },
    );
  }
}

/** a + b × S1 / S0, coefficients vérifiés. */
export function revisionCoefficient(a: Decimal, b: Decimal, S0: Decimal, S1: Decimal): Decimal {
  assertRevisionCoefficients(a, b);
  if (S0.isZero()) {
    throw new PricingError('DIVISION_BY_ZERO', 'Révision : l’indice de référence S0 vaut zéro.');
  }
  return a.plus(b.times(S1.div(S0)));
}

export interface RevisionComputation {
  readonly P0: Decimal;
  readonly a: Decimal;
  readonly b: Decimal;
  readonly S0: IndexObservation;
  readonly S1: IndexObservation;
  readonly ratio: Decimal;
  readonly coefficient: Decimal;
  /** P1 exact, non arrondi. */
  readonly exact: Decimal;
}

export function computeRevision(
  P0: Decimal,
  spec: RevisionSpec,
  indexes: readonly PriceIndex[],
  defaultLookup: IndexLookupRule,
): RevisionComputation {
  const a = parseDecimal(spec.a, 'révision : a');
  const b = parseDecimal(spec.b, 'révision : b');
  assertRevisionCoefficients(a, b);
  const rule = spec.lookup ?? defaultLookup;
  const S0 = lookupIndexValue(indexes, spec.indexCode, parseIsoDate(spec.referenceDate, 'révision : referenceDate'), rule);
  const S1 = lookupIndexValue(indexes, spec.indexCode, parseIsoDate(spec.revisionDate, 'révision : revisionDate'), rule);
  const s0 = D(S0.value);
  const s1 = D(S1.value);
  if (s0.isZero()) {
    throw new PricingError('DIVISION_BY_ZERO', `Révision : l’indice de référence S0 (${S0.indexCode} ${S0.period}) vaut zéro.`);
  }
  const ratio = s1.div(s0);
  const coefficient = a.plus(b.times(ratio));
  return { P0, a, b, S0, S1, ratio, coefficient, exact: P0.times(coefficient) };
}
