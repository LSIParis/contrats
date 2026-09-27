import DecimalJs from 'decimal.js';
import { PricingError } from './errors.js';

/**
 * Arithmétique monétaire. (brief §5 « Arrondis explicites et documentés »)
 *
 * Trois règles, et seulement trois :
 *
 *  1. Aucun `number` flottant ne touche un montant. Les prix unitaires sont des
 *     chaînes décimales (« 0.0125 »), converties en Decimal (decimal.js), et
 *     les montants de sortie sont des centimes entiers en `bigint`.
 *     Pourquoi bigint plutôt qu'un `number` entier sûr ? Parce qu'un total
 *     annuel agrégé sur un parc n'a pas de plafond métier, et qu'un
 *     dépassement de 2^53 ne lèverait AUCUNE erreur : il arrondirait en
 *     silence. Un bigint ne peut pas mentir de cette façon. Le prix à payer :
 *     la sérialisation JSON doit convertir explicitement (voir serialize.ts).
 *
 *  2. On n'arrondit qu'à des endroits NOMMÉS, tracés : prix unitaire à
 *     `unitPriceScale` décimales, total de ligne au centime, TVA par taux au
 *     centime, normalisation mensuelle d'un annuel au centime. Nulle part
 *     ailleurs. Les calculs intermédiaires restent exacts (40 chiffres
 *     significatifs, largement au-delà de toute grandeur de barème).
 *
 *  3. Le mode d'arrondi est un paramètre, pas une habitude :
 *     - HALF_AWAY_FROM_ZERO (défaut, « arrondi commercial ») : 0,125 → 0,13 et
 *       -0,125 → -0,13. Symétrique : une remise arrondie vaut exactement
 *       l'opposé du montant positif équivalent.
 *     - HALF_EVEN (« arrondi bancaire ») : 0,125 → 0,12 ; 0,135 → 0,14.
 *
 * Le constructeur Decimal est un CLONE configuré localement : on ne modifie
 * jamais la configuration globale de decimal.js, qu'une autre bibliothèque du
 * processus pourrait partager.
 */

export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = DecimalJs;

/** Raccourci de construction : `D('12.50')`. */
export const D = (v: DecimalJs.Value): Decimal => new Decimal(v);

export type RoundingMode = 'HALF_AWAY_FROM_ZERO' | 'HALF_EVEN';

/** decimal.js appelle ROUND_HALF_UP ce que la comptabilité appelle « demi à l'écart de zéro ». */
function rm(mode: RoundingMode): DecimalJs.Rounding {
  return mode === 'HALF_EVEN' ? DecimalJs.ROUND_HALF_EVEN : DecimalJs.ROUND_HALF_UP;
}

export function roundToScale(x: Decimal, scale: number, mode: RoundingMode = 'HALF_AWAY_FROM_ZERO'): Decimal {
  return x.toDecimalPlaces(scale, rm(mode));
}

/** Montant en euros (exact) → centimes entiers, arrondis selon `mode`. */
export function toCents(euros: Decimal, mode: RoundingMode = 'HALF_AWAY_FROM_ZERO'): bigint {
  return BigInt(euros.times(100).toDecimalPlaces(0, rm(mode)).toFixed(0));
}

export function centsToEuros(cents: bigint): Decimal {
  return D(cents.toString()).div(100);
}

/** Centimes → « 1288.67 » (point décimal, deux décimales, signe éventuel). */
export function formatCents(cents: bigint): string {
  return centsToEuros(cents).toFixed(2);
}

export interface ParseDecimalOptions {
  /** Nombre maximal de décimales acceptées (6 par défaut = précision de stockage). */
  readonly maxScale?: number;
  readonly allowNegative?: boolean;
}

// Volontairement strict : pas d'exposant, pas de virgule, pas d'espace, pas de
// « .5 » ni de « 1. ». Une saisie ambiguë est refusée, pas interprétée.
const DECIMAL_RE = /^(-?)(\d{1,20})(?:\.(\d+))?$/;

/**
 * Convertit une chaîne décimale d'entrée en Decimal, ou lève INVALID_DECIMAL.
 * `field` nomme la donnée fautive dans le message (ex. « lines[2].unitPrice »).
 */
export function parseDecimal(value: string, field: string, opts: ParseDecimalOptions = {}): Decimal {
  const maxScale = opts.maxScale ?? 6;
  const m = typeof value === 'string' ? DECIMAL_RE.exec(value) : null;
  if (!m) {
    throw new PricingError('INVALID_DECIMAL', `${field} : « ${String(value)} » n'est pas un décimal valide (format 1234.56).`, {
      field,
    });
  }
  if (m[1] === '-' && !opts.allowNegative) {
    throw new PricingError('INVALID_DECIMAL', `${field} : une valeur négative n'est pas admise ici.`, { field });
  }
  if ((m[3]?.length ?? 0) > maxScale) {
    throw new PricingError('INVALID_DECIMAL', `${field} : au plus ${maxScale} décimales.`, { field, maxScale });
  }
  return D(value);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Valide une date calendaire « YYYY-MM-DD ».
 *
 * Le moteur ne manipule QUE des dates calendaires (jamais d'instant) : « le
 * tarif du 1er janvier » n'a pas de fuseau. La conversion instant → jour
 * (Europe/Paris) est de la responsabilité de l'appelant, une seule fois, à la
 * frontière. Les chaînes ISO se comparent alors lexicographiquement, sans
 * aucun objet Date, donc sans aucune dépendance à l'horloge ni au fuseau.
 */
export function parseIsoDate(value: string, field: string): string {
  const m = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d) return value;
  }
  throw new PricingError('INVALID_DATE', `${field} : « ${String(value)} » n'est pas une date YYYY-MM-DD valide.`, { field });
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Valide une période d'indice « YYYY-MM ». */
export function parsePeriod(value: string, field: string): string {
  if (typeof value === 'string' && PERIOD_RE.test(value)) return value;
  throw new PricingError('INVALID_DATE', `${field} : « ${String(value)} » n'est pas une période YYYY-MM valide.`, { field });
}
