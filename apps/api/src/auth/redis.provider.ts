import { Redis } from 'ioredis';
import type { Provider } from '@nestjs/common';

export const REDIS = Symbol('REDIS');

/**
 * Client Redis partagé, fourni par le conteneur d'injection.
 *
 * `lazyConnect: false` (défaut) : la connexion s'établit au démarrage. En cas
 * d'indisponibilité de Redis, ioredis retente ; l'auth échoue proprement
 * plutôt que de laisser passer des requêtes sans session.
 */
export const RedisProvider: Provider = {
  provide: REDIS,
  useFactory: () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL absent — requis pour les sessions (§9.2)');
    return new Redis(url, { maxRetriesPerRequest: 3 });
  },
};
