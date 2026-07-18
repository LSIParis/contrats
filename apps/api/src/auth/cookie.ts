import type { Response } from 'express';

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

export function setSessionCookie(res: Response, sessionId: string, maxAgeSeconds: number): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: PROD,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/' });
}
