import { Injectable } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';

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

/**
 * Store de sessions serveur. (§9.2)
 *
 * Cookie opaque → session serveur, PAS de JWT.
 *
 * Un JWT embarque le scope. Le scope change : un account manager perd un
 * client (EC-17). Un JWT valide 15 minutes, c'est 15 minutes d'accès à des
 * données qu'on vient de lui retirer. On peut raccourcir la durée, ajouter
 * une liste de révocation, consulter un cache à chaque requête — mais on a
 * alors reconstruit une session serveur, en moins fiable.
 *
 * À moins de 20 utilisateurs internes (H5), le seul argument en faveur du
 * JWT — l'absence d'état — n'achète rien.
 *
 * En production : Redis. Ici : en mémoire, derrière la même interface.
 */
@Injectable()
export class SessionService {
  private readonly sessions = new Map<string, Session>();

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  put(s: Session): void {
    this.sessions.set(s.sessionId, s);
  }

  /**
   * Révocation immédiate (EC-17). C'est précisément ce qu'un JWT ne sait
   * pas faire : le retrait d'un client du portefeuille prend effet à la
   * requête suivante, pas à l'expiration du jeton.
   */
  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revokeAllForUser(userId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) this.sessions.delete(id);
    }
  }
}
