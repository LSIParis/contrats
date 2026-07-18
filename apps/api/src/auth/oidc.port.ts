/**
 * Port OIDC. (§13.1, Phase B)
 *
 * Le service de login connaît cette interface, pas openid-client ni Entra.
 * Testable avec un fake ; l'adaptateur réel (Entra) est validé contre le
 * vrai IdP quand les identifiants sont fournis.
 */
export const OIDC_PROVIDER = Symbol('OIDC_PROVIDER');

export interface OidcAuthRequest {
  /** URL d'autorisation vers laquelle rediriger le navigateur. */
  readonly authorizationUrl: string;
  /** Anti-CSRF : rejoué au callback. */
  readonly state: string;
  /** Anti-rejeu du jeton d'identité. */
  readonly nonce: string;
  /** PKCE : lie la demande à l'échange de code. */
  readonly codeVerifier: string;
}

/** Identité vérifiée renvoyée par l'IdP après validation du jeton. */
export interface OidcIdentity {
  readonly email: string;
  readonly sub: string;
  readonly name?: string;
}

export interface OidcProvider {
  createAuthRequest(redirectUri: string): Promise<OidcAuthRequest>;

  /**
   * Échange le code contre les jetons et VALIDE le jeton d'identité
   * (signature via JWKS, nonce, state, PKCE). Lève si invalide.
   */
  verifyCallback(input: {
    currentUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcIdentity>;
}
