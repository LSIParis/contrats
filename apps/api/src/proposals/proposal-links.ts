import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Jetons de la page publique (brief §12.5) : 256 bits d'aléa (≥ 128 exigés),
 * encodés base64url. Seul leur SHA-256 est stocké ; le jeton en clair n'existe
 * que dans l'e-mail du destinataire.
 */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Forme d'un jeton émis par `newToken` : on ne hache pas n'importe quelle chaîne. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Code à usage unique (6 chiffres), haché avec l'identifiant du lien. */
export function newOtp(linkId: string): { code: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: otpHash(linkId, code) };
}

export function otpHash(linkId: string, code: string): string {
  return createHash('sha256').update(`${linkId}:${code}`).digest('hex');
}

export function sameHash(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_SESSION_TTL_MS = 60 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** Lien public absolu (le jeton est dans le CHEMIN : jamais dans un journal d'accès côté API). */
export function publicLink(token: string): string {
  const base = (process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr').replace(/\/+$/, '');
  return `${base}/p/${token}`;
}

/** Gabarit d'e-mail (balises limitées, valeurs déjà formatées). */
export function renderEmailTemplate(tpl: string, values: Readonly<Record<string, string>>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, k: string) => values[k] ?? whole);
}
