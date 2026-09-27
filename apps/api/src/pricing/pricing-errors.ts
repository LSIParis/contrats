import { HttpException, HttpStatus } from '@nestjs/common';
import { PricingError, type PricingErrorCode } from '@lsi/pricing';

/**
 * Traduction des erreurs du moteur en réponses HTTP (04-tarification.md §13).
 *
 * Corps au format RFC 9457 (`type`, `title`, `status`, `detail`) enrichi du
 * `code` stable du moteur et de ses `details` (lineId, position…) : l'interface
 * décide sur le CODE, jamais sur le texte. Le filtre global préserve ce corps
 * et y ajoute `requestId`.
 *
 *  - 404 : aucune version de barème à la date (le prix « n'existe pas ») ;
 *  - 409 : l'état des données empêche le calcul (valeur d'indice absente,
 *          quantité non remontée, règle introuvable) — on corrige les
 *          DONNÉES, pas la requête ;
 *  - 422 : barème ou saisie incohérents (ligne, formule, révision, remise).
 */
const CONFLICT: ReadonlySet<PricingErrorCode> = new Set<PricingErrorCode>([
  'INDEX_NOT_FOUND',
  'INDEX_VALUE_NOT_FOUND',
  'DUPLICATE_INDEX_VALUE',
  'MISSING_QUANTITY',
  'QUANTITY_UNAVAILABLE',
  'RULE_NOT_FOUND',
]);

export function pricingStatus(code: PricingErrorCode): number {
  if (code === 'NO_SCHEDULE') return HttpStatus.NOT_FOUND;
  if (CONFLICT.has(code)) return HttpStatus.CONFLICT;
  return HttpStatus.UNPROCESSABLE_ENTITY;
}

export function toHttp(e: PricingError): HttpException {
  const status = pricingStatus(e.code);
  return new HttpException(
    {
      type: `urn:lsi:contrats:pricing:${e.code.toLowerCase().replace(/_/g, '-')}`,
      title: e.code,
      status,
      statusCode: status,
      code: e.code,
      detail: e.message,
      message: e.message,
      details: e.details,
    },
    status,
  );
}

/** Exécute `fn` et traduit toute PricingError en réponse HTTP typée. */
export async function mapPricingErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PricingError) throw toHttp(e);
    throw e;
  }
}

/** Erreurs qui rendent un barème INCALCULABLE (refus d'activation). */
export const STRUCTURAL_ERRORS: ReadonlySet<PricingErrorCode> = new Set<PricingErrorCode>([
  'INVALID_DECIMAL',
  'INVALID_DATE',
  'INVALID_LINE',
  'INVALID_SETTINGS',
  'RULE_NOT_FOUND',
  'NEGATIVE_PRICE',
  'MISSING_CONTEXT',
  'INVALID_REVISION_COEFFICIENTS',
  'DISCOUNT_TARGET_MISMATCH',
  'DISCOUNT_EXCEEDS_BASE',
  'FORMULA_SYNTAX',
  'FORMULA_UNKNOWN_VARIABLE',
  'FORMULA_UNKNOWN_FUNCTION',
  'FORMULA_ARITY',
  'FORMULA_LIMIT',
  'FORMULA_EVALUATION',
  'DIVISION_BY_ZERO',
]);
