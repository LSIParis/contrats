import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Scope } from '@lsi/persistence';
import { REDIS } from './redis.provider.js';
import { RedisSessionStore } from './redis-session-store.js';

export type RoleCode =
  | 'MSP_ADMIN'
  | 'ACCOUNT_MANAGER'
  | 'LEGAL_REVIEWER'
  | 'TECHNICIAN'
  | 'CLIENT_SIGNER'
  | 'CLIENT_VIEWER';

export interface Session {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly RoleCode[];
  /** Résolu au login, jamais transmis par le client (§10.4). */
  readonly scope: Scope;
}

/** TTL de session par famille (§13.1). */
export const SESSION_TTL = {
  INTERNAL: 8 * 3600, // 8 h
  CLIENT: 30 * 60, // 30 min
} as const;

/**
 * Sessions serveur, désormais adossées à Redis (Phase B).
 *
 * Cookie opaque → session serveur, PAS de JWT (§9.2). Un JWT embarque le
 * scope, qui change (un account manager perd un client, EC-17) ; 15 minutes
 * de validité = 15 minutes d'accès à ce qu'on vient de retirer. La session
 * serveur donne la révocation immédiate et un scope toujours frais.
 */
@Injectable()
export class SessionService {
  private readonly store: RedisSessionStore;

  constructor(@Inject(REDIS) redis: Redis) {
    this.store = new RedisSessionStore(redis);
  }

  get(sessionId: string): Promise<Session | null> {
    return this.store.get(sessionId);
  }

  put(session: Session, ttlSeconds: number = SESSION_TTL.INTERNAL): Promise<void> {
    return this.store.put(session, ttlSeconds);
  }

  /** Révocation immédiate (EC-17). */
  revoke(sessionId: string): Promise<void> {
    return this.store.revoke(sessionId);
  }

  revokeAllForUser(userId: string): Promise<void> {
    return this.store.revokeAllForUser(userId);
  }
}
