import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../auth/redis.provider.js';

/**
 * Limitation de débit de la page publique (brief §12.5). Compteurs Redis à
 * fenêtre fixe, partagés par tous les conteneurs `app`. En cas d'indisponibilité
 * de Redis, on LAISSE PASSER (la page ne tombe pas avec le cache) — les
 * jetons de 256 bits rendent l'énumération inopérante de toute façon.
 */
@Injectable()
export class PublicRateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(bucket: string, key: string, limit: number, windowSeconds: number): Promise<void> {
    let n: number;
    try {
      const k = `rl:${bucket}:${key}`;
      n = await this.redis.incr(k);
      if (n === 1) await this.redis.expire(k, windowSeconds);
    } catch {
      return;
    }
    if (n > limit) {
      throw new HttpException(
        { statusCode: 429, code: 'RATE_LIMITED', detail: 'Trop de requêtes : réessayez dans un instant.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
