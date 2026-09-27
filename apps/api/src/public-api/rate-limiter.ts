/**
 * Limitation de débit par client d'API : fenêtre glissante d'une minute,
 * en mémoire du processus (V2-H32 : une instance d'API par déploiement ; à
 * déplacer dans Redis si l'API est un jour répliquée).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs = 60_000) {}

  /** Consomme un jeton ; renvoie l'état pour les en-têtes `RateLimit-*`. */
  take(clientId: string, limit: number, now = Date.now()): { allowed: boolean; remaining: number; resetSeconds: number } {
    const since = now - this.windowMs;
    const list = (this.hits.get(clientId) ?? []).filter((t) => t > since);
    const allowed = list.length < limit;
    if (allowed) list.push(now);
    this.hits.set(clientId, list);
    const oldest = list[0] ?? now;
    return {
      allowed,
      remaining: Math.max(0, limit - list.length),
      resetSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
    };
  }
}
