import type { FastifyReply } from 'fastify';

/**
 * Cookie de session. (§13.1)
 *
 * Préfixe `__Host-` : le navigateur n'accepte ce cookie que s'il est `Secure`,
 * `Path=/`, et SANS `Domain` — il ne peut donc pas être posé par un
 * sous-domaine ni détourné. `httpOnly` : inaccessible au JavaScript (anti-XSS).
 * `SameSite=Strict` : jamais envoyé en cross-site (anti-CSRF).
 *
 * En développement (HTTP), `__Host-` exige quand même Secure, ce qui casse
 * sur http://localhost. On retire alors le préfixe et Secure — jamais en
 * production.
 */
const PROD = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE = PROD ? '__Host-lsi_sess' : 'lsi_sess';

export function setSessionCookie(res: FastifyReply, sessionId: string, maxAgeSeconds: number): void {
  void res.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: PROD,
    sameSite: 'strict',
    path: '/',
    // @fastify/cookie : maxAge en SECONDES (Express l'attendait en ms).
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(res: FastifyReply): void {
  void res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/' });
}
