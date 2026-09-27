import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Chiffrement des secrets d'abonnement (AES-256-GCM). (08-securite-rgpd.md)
 *
 * Le secret HMAC doit être RELU pour signer chaque livraison : un hachage ne
 * convient donc pas. Il est chiffré avec une clé applicative fournie par
 * l'environnement (`WEBHOOK_SECRET_KEY`, 32 octets en base64 ou 64 hex), JAMAIS
 * stockée en base : une fuite de la base seule ne livre aucun secret.
 *
 * VERSION DE CLÉ : chaque ligne porte `secret_key_version`. Rotation :
 *   1. l'ancienne clé passe dans `WEBHOOK_SECRET_KEY_V<n>` (n = son numéro),
 *   2. la nouvelle devient `WEBHOOK_SECRET_KEY` et `WEBHOOK_SECRET_KEY_VERSION`
 *      est incrémenté ;
 * les secrets existants restent lisibles (clé de leur version), les nouveaux
 * (création, rotation de secret) sont chiffrés avec la clé courante.
 *
 * Format stocké : `base64(iv 12 o).base64(tag 16 o).base64(chiffré)`. La
 * version de clé est dans sa propre colonne et entre dans l'AAD : un chiffré
 * recollé sur une autre version (ou un autre abonnement) échoue au déchiffrement.
 */
const ALGO = 'aes-256-gcm';

function parseKey(raw: string, name: string): Buffer {
  const v = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (buf.length !== 32) throw new Error(`${name} doit contenir 32 octets (base64 ou 64 caractères hex)`);
  return buf;
}

export interface KeyRing {
  readonly currentVersion: number;
  key(version: number): Buffer;
}

/**
 * Trousseau lu dans l'environnement. Hors production, en l'absence de clé,
 * une clé de DÉVELOPPEMENT déterministe est dérivée (tests, poste local) ; en
 * production l'absence de clé est une erreur au premier usage — on ne chiffre
 * jamais « à blanc ».
 */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const currentVersion = Number(env.WEBHOOK_SECRET_KEY_VERSION ?? '1');
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error('WEBHOOK_SECRET_KEY_VERSION doit être un entier ≥ 1');
  }
  return {
    currentVersion,
    key(version: number): Buffer {
      const name = version === currentVersion ? 'WEBHOOK_SECRET_KEY' : `WEBHOOK_SECRET_KEY_V${version}`;
      const raw = env[name];
      if (raw) return parseKey(raw, name);
      if (env.NODE_ENV === 'production') throw new Error(`${name} absente : secrets des webhooks indéchiffrables`);
      return createHash('sha256').update(`contrats-dev-webhook-key-v${version}`).digest();
    },
  };
}

const aad = (subscriptionId: string, version: number) => Buffer.from(`${subscriptionId}:${version}`, 'utf8');

export function encryptSecret(ring: KeyRing, subscriptionId: string, plaintext: string): { ciphertext: string; keyVersion: number } {
  const version = ring.currentVersion;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, ring.key(version), iv);
  cipher.setAAD(aad(subscriptionId, version));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`, keyVersion: version };
}

export function decryptSecret(ring: KeyRing, subscriptionId: string, stored: string, keyVersion: number): string {
  const [iv, tag, ct] = stored.split('.');
  if (!iv || !tag || !ct) throw new Error('secret chiffré illisible (format)');
  const decipher = createDecipheriv(ALGO, ring.key(keyVersion), Buffer.from(iv, 'base64'));
  decipher.setAAD(aad(subscriptionId, keyVersion));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
