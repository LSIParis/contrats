import { randomUUID } from 'node:crypto';
import type { OidcAuthRequest, OidcIdentity, OidcProvider } from '../../src/auth/oidc.port.js';

/**
 * Provider OIDC simulé, pour tester la LOGIQUE de login sans vrai IdP.
 *
 * `nextIdentity` fixe l'identité que `verifyCallback` renverra ; `failNext`
 * fait échouer la vérification (jeton invalide). La conformité du protocole
 * OIDC réel est du ressort de l'adaptateur Entra, testé contre Entra.
 */
export class FakeOidcProvider implements OidcProvider {
  private identity: OidcIdentity | null = null;
  private fail = false;
  readonly requests: OidcAuthRequest[] = [];

  setNextIdentity(id: OidcIdentity): void {
    this.identity = id;
    this.fail = false;
  }

  failNext(): void {
    this.fail = true;
  }

  async createAuthRequest(redirectUri: string): Promise<OidcAuthRequest> {
    const req: OidcAuthRequest = {
      authorizationUrl: `https://idp.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      state: randomUUID(),
      nonce: randomUUID(),
      codeVerifier: randomUUID(),
    };
    this.requests.push(req);
    return req;
  }

  async verifyCallback(): Promise<OidcIdentity> {
    if (this.fail || !this.identity) throw new Error('jeton OIDC invalide (fake)');
    return this.identity;
  }
}
