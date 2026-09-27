/**
 * Erreurs typées du moteur de tarification.
 *
 * Toutes héritent de PricingError et portent un `code` stable : c'est lui que
 * l'API traduira en `application/problem+json` (RFC 9457) et que l'interface
 * affichera. Le message est destiné à un humain ; le code à une machine. Ne
 * jamais faire dépendre un comportement du texte du message.
 *
 * Principe directeur : le moteur ne DEVINE jamais. Une valeur d'indice absente,
 * une quantité non remontée, deux barèmes qui se chevauchent : c'est une erreur,
 * pas une valeur par défaut silencieuse. Un prix faux facturé est pire qu'un
 * prix non calculé.
 */

export type PricingErrorCode =
  // Données d'entrée
  | 'INVALID_DECIMAL'
  | 'INVALID_DATE'
  | 'INVALID_LINE'
  | 'INVALID_SETTINGS'
  | 'NO_SCHEDULE'
  | 'OVERLAPPING_SCHEDULES'
  | 'MISSING_QUANTITY'
  | 'MISSING_CONTEXT'
  | 'RULE_NOT_FOUND'
  | 'NEGATIVE_PRICE'
  // Indices et révision
  | 'INDEX_NOT_FOUND'
  | 'INDEX_VALUE_NOT_FOUND'
  | 'DUPLICATE_INDEX_VALUE'
  | 'INVALID_REVISION_COEFFICIENTS'
  // Dérogations
  | 'AMBIGUOUS_OVERRIDE'
  // Remises
  | 'DISCOUNT_TARGET_MISMATCH'
  | 'DISCOUNT_EXCEEDS_BASE'
  // Formules
  | 'FORMULA_SYNTAX'
  | 'FORMULA_UNKNOWN_VARIABLE'
  | 'FORMULA_UNKNOWN_FUNCTION'
  | 'FORMULA_ARITY'
  | 'FORMULA_LIMIT'
  | 'FORMULA_EVALUATION'
  | 'DIVISION_BY_ZERO'
  // Fournisseurs de quantités
  | 'QUANTITY_UNAVAILABLE';

export type PricingErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export class PricingError extends Error {
  constructor(
    readonly code: PricingErrorCode,
    message: string,
    readonly details: PricingErrorDetails = {},
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Erreur de formule : porte en plus la position (index 0 du caractère fautif)
 * pour que l'éditeur de formule puisse souligner l'endroit exact.
 */
export class FormulaError extends PricingError {
  constructor(
    code: Extract<
      PricingErrorCode,
      | 'FORMULA_SYNTAX'
      | 'FORMULA_UNKNOWN_VARIABLE'
      | 'FORMULA_UNKNOWN_FUNCTION'
      | 'FORMULA_ARITY'
      | 'FORMULA_LIMIT'
      | 'FORMULA_EVALUATION'
      | 'DIVISION_BY_ZERO'
    >,
    message: string,
    readonly position: number | null = null,
    details: PricingErrorDetails = {},
  ) {
    super(code, message, { ...details, position });
    this.name = 'FormulaError';
  }
}
