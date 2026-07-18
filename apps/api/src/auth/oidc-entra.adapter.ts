import { Injectable, Logger } from '@nestjs/common';
import * as oidc from 'openid-client';
import type { OidcAuthRequest, OidcIdentity, OidcProvider } from './oidc.port.js';

/**
 * Adaptateur OIDC Entra ID (openid-client v6). (§13.1)
 *
 * ⚠ NON TESTÉ automatiquement : la validation OIDC (signature JWKS, nonce)
 * ne peut se vérifier que contre un vrai IdP. Les tests couvrent la LOGIQUE
 * de login via un fake. Cet adaptateur est à valider contre le tenant Entra
 * réel dès que les identifiants sont fournis — comme DocuSeal et Gotenberg
 * l'ont été. Le port isole ce risque.
 *
 * Config attendue :
 *   OIDC_ISSUER        https://login.microsoftonline.com/{tenantId}/v2.0
 *   OIDC_CLIENT_ID     id de l'application enregistrée dans Entra
 *   OIDC_CLIENT_SECRET secret de l'application
 */
@Injectable()
export class EntraOidcProvider implements OidcProvider {
  private readonly log = new Logger(EntraOidcProvider.name);
  private configPromise?: Promise<oidc.Configuration>;

  private config(): Promise<oidc.Configuration> {
    if (!this.configPromise) {
      const issuer = process.env.OIDC_ISSUER;
      const clientId = process.env.OIDC_CLIENT_ID;
      const clientSecret = process.env.OIDC_CLIENT_SECRET;
      if (!issuer || !clientId || !clientSecret) {
        throw new Error('OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET absents');
      }
      // Découverte du document OIDC de l'issuer (endpoints + JWKS).
      this.configPromise = oidc.discovery(new URL(issuer), clientId, clientSecret);
    }
    return this.configPromise;
  }

  async createAuthRequest(redirectUri: string): Promise<OidcAuthRequest> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const authorizationUrl = oidc
      .buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Entra : force le choix de compte, évite les sessions collées.
        prompt: 'select_account',
      })
      .href;

    return { authorizationUrl, state, nonce, codeVerifier };
  }

  async verifyCallback(input: {
    currentUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcIdentity> {
    const config = await this.config();
    // authorizationCodeGrant valide le state, échange le code, et VALIDE le
    // jeton d'identité (signature via JWKS, nonce, audience, expiration).
    const tokens = await oidc.authorizationCodeGrant(config, new URL(input.currentUrl), {
      expectedState: input.state,
      expectedNonce: input.nonce,
      pkceCodeVerifier: input.codeVerifier,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error('Jeton d’identité sans claims');

    // Entra : l'email peut être dans `email` ou `preferred_username`.
    const email = (claims.email as string) ?? (claims.preferred_username as string);
    if (!email) throw new Error('Jeton d’identité sans email');

    return {
      email,
      sub: String(claims.sub),
      name: claims.name as string | undefined,
    };
  }
}
