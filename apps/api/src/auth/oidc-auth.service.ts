import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { findLoginUser, findTenantBySlug, resolveUserScope, uuidv7 } from '@lsi/persistence';
import { REDIS } from './redis.provider.js';
import { OIDC_PROVIDER, type OidcProvider } from './oidc.port.js';
import { SessionService, SESSION_TTL, type RoleCode } from './session.service.js';

const STATE_TTL_SECONDS = 10 * 60; // 10 min pour compléter le login

interface PendingLogin {
  nonce: string;
  codeVerifier: string;
}

/**
 * Authentification interne par OIDC (Entra ID). (§13.1)
 *
 * Réservé aux comptes INTERNES : MFA, offboarding et conditional access sont
 * délégués à M365. Un compte CLIENT ne passe jamais par là (il a le magic
 * link) — le callback le refuse explicitement.
 *
 * Le scope n'est jamais porté par le jeton OIDC : on récupère l'identité
 * validée, puis on résout le scope depuis NOTRE base (§10.4).
 */
@Injectable()
export class OidcAuthService {
  private readonly log = new Logger(OidcAuthService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    private readonly sessions: SessionService,
  ) {}

  private redirectUri(): string {
    const base = process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr';
    return `${base}/v1/auth/callback`;
  }

  private key(state: string): string {
    return `oidc_state:${state}`;
  }

  /** Démarre le login : renvoie l'URL vers laquelle rediriger le navigateur. */
  async begin(): Promise<string> {
    const req = await this.oidc.createAuthRequest(this.redirectUri());
    const pending: PendingLogin = { nonce: req.nonce, codeVerifier: req.codeVerifier };
    // Le state indexe la demande en cours ; anti-CSRF + usage unique.
    await this.redis.set(this.key(req.state), JSON.stringify(pending), 'EX', STATE_TTL_SECONDS);
    return req.authorizationUrl;
  }

  /**
   * Traite le callback. Renvoie l'id de session + TTL, ou null si l'auth
   * échoue (state inconnu, jeton invalide, utilisateur non interne/inconnu).
   */
  async complete(currentUrl: string, state: string): Promise<{ sessionId: string; ttl: number } | null> {
    if (!state) return null;
    const raw = await this.redis.get(this.key(state));
    if (!raw) return null; // state inconnu ou expiré → possible CSRF, on refuse
    await this.redis.del(this.key(state)); // usage unique

    const { nonce, codeVerifier } = JSON.parse(raw) as PendingLogin;

    let identity;
    try {
      identity = await this.oidc.verifyCallback({
        currentUrl,
        state,
        nonce,
        codeVerifier,
        redirectUri: this.redirectUri(),
      });
    } catch (e) {
      this.log.warn(`callback OIDC rejeté : ${(e as Error).message}`);
      return null;
    }

    const tenantId = await findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi');
    if (!tenantId) return null;

    const user = await findLoginUser(tenantId, identity.email);
    // OIDC est réservé à l'interne. Un email inconnu, ou un compte CLIENT,
    // ne peut pas ouvrir de session interne.
    if (!user || user.kind !== 'INTERNAL') {
      this.log.warn(`OIDC : ${identity.email} inconnu ou non-interne`);
      return null;
    }

    const resolved = await resolveUserScope(tenantId, user.userId);
    if (!resolved || resolved.kind !== 'INTERNAL') return null;

    const sessionId = uuidv7();
    await this.sessions.put(
      {
        sessionId,
        userId: user.userId,
        tenantId,
        roles: resolved.roles as RoleCode[],
        scope: resolved.scope,
      },
      SESSION_TTL.INTERNAL,
    );
    return { sessionId, ttl: SESSION_TTL.INTERNAL };
  }
}
