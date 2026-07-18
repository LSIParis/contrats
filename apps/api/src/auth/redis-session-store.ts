import type Redis from 'ioredis';
import type { Session } from './session.service.js';

/**
 * Store de sessions Redis. (§9.2, Phase B)
 *
 * Remplace le store en mémoire. Deux propriétés que le cookie JWT ne saurait
 * pas offrir et qui justifient le choix de la session serveur :
 *   - RÉVOCATION IMMÉDIATE (EC-17) : `revoke` supprime la session ; la requête
 *     suivante est refusée. Un JWT resterait valide jusqu'à expiration.
 *   - SCOPE TOUJOURS FRAIS : le scope est relu à chaque requête, jamais figé
 *     dans un jeton.
 *
 * Deux structures :
 *   sess:<id>            → JSON de la session, avec TTL
 *   user_sessions:<uid>  → set des sessionId de l'utilisateur (offboarding)
 */
export class RedisSessionStore {
  constructor(private readonly redis: Redis) {}

  private key(sessionId: string): string {
    return `sess:${sessionId}`;
  }

  private userKey(userId: string): string {
    return `user_sessions:${userId}`;
  }

  async put(session: Session, ttlSeconds: number): Promise<void> {
    const k = this.key(session.sessionId);
    const uk = this.userKey(session.userId);
    // Pipeline atomique : la session et son index sont écrits ensemble.
    await this.redis
      .multi()
      .set(k, JSON.stringify(session), 'EX', ttlSeconds)
      .sadd(uk, session.sessionId)
      // L'index expire un peu après la session la plus longue possible :
      // il ne doit pas fuir indéfiniment, mais ne doit pas expirer avant
      // les sessions qu'il référence.
      .expire(uk, ttlSeconds + 3600)
      .exec();
  }

  async get(sessionId: string): Promise<Session | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }

  /** Révocation immédiate d'une session (EC-17). */
  async revoke(sessionId: string): Promise<void> {
    const s = await this.get(sessionId);
    await this.redis.del(this.key(sessionId));
    // On retire aussi la référence de l'index utilisateur pour ne pas laisser
    // de trace morte que revokeAllForUser aurait à balayer.
    if (s) await this.redis.srem(this.userKey(s.userId), sessionId);
  }

  /**
   * Révoque TOUTES les sessions d'un utilisateur — offboarding, changement
   * de rôle, compromission. C'est précisément ce qu'un JWT ne sait pas faire.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const uk = this.userKey(userId);
    const ids = await this.redis.smembers(uk);
    const pipe = this.redis.multi();
    for (const id of ids) pipe.del(this.key(id));
    pipe.del(uk);
    await pipe.exec();
  }
}
