import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Clé d'API de l'API publique : `ctr_<prefix>_<secret>` (V2-H8).
 *
 * - `prefix` : 12 caractères [a-z0-9], public, sert à retrouver la ligne ;
 * - `secret` : 32 octets aléatoires en base64url (256 bits), jamais stocké —
 *   seul son SHA-256 l'est. Un hachage lent (argon2, scrypt) protège les mots
 *   de passe faibles ; il n'apporte rien contre un secret de 256 bits.
 * La clé complète n'est montrée qu'UNE fois, à la création ou à la rotation.
 */
export const API_SCOPES = ['contracts:read', 'contracts:dates:read', 'pricing:read', 'pricing:quote', 'webhooks:manage'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_RE = /^ctr_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(12);
  const prefix = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  const secret = randomBytes(32).toString('base64url');
  return { key: `ctr_${prefix}_${secret}`, prefix, hash: hashSecret(secret) };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
export function hashMatches(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(expectedHash.trim(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
