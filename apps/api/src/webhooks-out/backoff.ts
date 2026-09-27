/**
 * Échéancier de reprise des livraisons. (07-api.md §Webhooks sortants)
 *
 * Tentative 1 immédiate (au plus tard au passage suivant du job minute),
 * puis reprises après 1 min, 5 min, 30 min, 2 h et 12 h : six tentatives sur
 * ~14 h 36. Au-delà : DEAD (plus aucune tentative automatique ; relivrable à
 * la main par `POST /v1/admin/webhook-deliveries/:id/redeliver`).
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
];

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Après l'échec de la tentative numéro `attempt` (1 = la première), renvoie
 * la date de la prochaine tentative, ou `null` si l'échéancier est épuisé.
 */
export function nextAttemptAfterFailure(attempt: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempt - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

/** Seuil de désactivation automatique d'un abonnement (livraisons DEAD consécutives). */
export function disableAfterDead(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WEBHOOKS_DISABLE_AFTER_DEAD ?? '20');
  return Number.isInteger(n) && n >= 1 ? n : 20;
}
