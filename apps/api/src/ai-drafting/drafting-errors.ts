import { BadGatewayException, GatewayTimeoutException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { PseudonymizationLeakError } from '@lsi/domain';

/**
 * Erreurs TYPÉES de la rédaction IA structurée.
 *
 * Volontairement indépendantes de Nest et de tout SDK : l'adaptateur les lève,
 * le service (ou le futur worker) décide de la réponse HTTP ou du réessai.
 * `retryable` dit si réessayer PLUS TARD a un sens — pas s'il faut le faire
 * immédiatement (le 429 doit attendre `retryAfterSeconds`).
 *
 * Règle commune : en cas d'erreur, AUCUN brouillon partiel n'est rendu. Un
 * projet de contrat à moitié généré ressemble à un projet complet ; c'est le
 * pire résultat possible pour une relecture juridique.
 */

export type AiErrorKind =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'SCHEMA_VIOLATION'
  | 'UPSTREAM';

export abstract class AiDraftingError extends Error {
  abstract readonly kind: AiErrorKind;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Aucun fournisseur configuré, ou ni `model` ni `preset` fourni. */
export class AiNotConfiguredError extends AiDraftingError {
  readonly kind = 'NOT_CONFIGURED' as const;
  readonly retryable = false;
}

/** 401 / 403 : clé absente, invalide, révoquée, ou crédit épuisé (Perplexity renvoie 401 dans ce cas). */
export class AiAuthError extends AiDraftingError {
  readonly kind = 'AUTH' as const;
  readonly retryable = false;
}

/** 400 / 422 : requête refusée (modèle inconnu, schéma invalide, paramètre hors bornes). */
export class AiBadRequestError extends AiDraftingError {
  readonly kind = 'BAD_REQUEST' as const;
  readonly retryable = false;
}

/** 429 : quota ou débit dépassé. */
export class AiRateLimitError extends AiDraftingError {
  readonly kind = 'RATE_LIMIT' as const;
  readonly retryable = true;

  constructor(message: string, provider: string, readonly retryAfterSeconds?: number, options?: { cause?: unknown }) {
    super(message, provider, 429, options);
  }
}

/** Délai dépassé (le premier appel d'un nouveau schéma est plus lent : 10–30 s de préparation). */
export class AiTimeoutError extends AiDraftingError {
  readonly kind = 'TIMEOUT' as const;
  readonly retryable = true;

  constructor(message: string, provider: string, readonly timeoutMs: number, options?: { cause?: unknown }) {
    super(message, provider, undefined, options);
  }
}

/** Réponse reçue mais inexploitable : JSON invalide, non conforme au schéma, génération incomplète. */
export class AiSchemaViolationError extends AiDraftingError {
  readonly kind = 'SCHEMA_VIOLATION' as const;
  readonly retryable = true;

  constructor(message: string, provider: string, readonly issues: readonly string[] = [], options?: { cause?: unknown }) {
    super(message, provider, undefined, options);
  }
}

/** 5xx, réseau, réponse `failed`. */
export class AiUpstreamError extends AiDraftingError {
  readonly kind = 'UPSTREAM' as const;
  readonly retryable = true;
}

/**
 * Traduction HTTP pour les contrôleurs internes. Les messages restent
 * génériques côté client ; la cause est conservée pour les journaux serveur.
 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  const cause = err instanceof Error ? err : undefined;
  if (err instanceof PseudonymizationLeakError) {
    // Refus de NOTRE garde-fou : rien n'est parti. Erreur interne, pas du fournisseur.
    return new ServiceUnavailableException('Assistance IA : envoi refusé, des données sensibles n’ont pas pu être pseudonymisées.', { cause });
  }
  if (!(err instanceof AiDraftingError)) {
    return new ServiceUnavailableException('Assistance IA indisponible pour le moment.', { cause });
  }
  switch (err.kind) {
    case 'NOT_CONFIGURED':
      return new ServiceUnavailableException('Assistance IA non configurée.', { cause });
    case 'AUTH':
      return new ServiceUnavailableException(
        `Assistance IA : clé API ${err.provider} invalide, révoquée ou crédit épuisé. Vérifiez la configuration.`,
        { cause },
      );
    case 'RATE_LIMIT':
      return new ServiceUnavailableException('Assistance IA momentanément indisponible (quota atteint). Réessayez plus tard.', { cause });
    case 'TIMEOUT':
      return new GatewayTimeoutException('Assistance IA : délai dépassé. Réessayez.', { cause });
    case 'SCHEMA_VIOLATION':
      return new BadGatewayException('Assistance IA : réponse non conforme, aucun brouillon créé. Réessayez.', { cause });
    case 'BAD_REQUEST':
      return new BadGatewayException('Assistance IA : requête refusée par le fournisseur (modèle ou paramètres).', { cause });
    default:
      return new ServiceUnavailableException('Assistance IA indisponible pour le moment.', { cause });
  }
}
