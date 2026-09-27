import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signature des webhooks sortants. (docs/contrats/07-api.md §Webhooks sortants)
 *
 *   X-Contrats-Timestamp: <secondes Unix>
 *   X-Contrats-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<corps brut>")>
 *
 * Le timestamp est DANS le message signé : un attaquant qui rejoue une
 * requête capturée ne peut pas rafraîchir l'horodatage sans invalider la
 * signature, et le consommateur refuse tout écart supérieur à la tolérance
 * (±5 min) — c'est l'anti-rejeu. Le préfixe `v1=` versionne le schéma : un
 * futur `v2=` pourra cohabiter dans le même en-tête (séparé par des virgules)
 * pendant une migration.
 *
 * `verifyWebhookSignature` est la fonction que les consommateurs recopient
 * (07-api.md la reproduit) : comparaison à TEMPS CONSTANT, sur le corps BRUT
 * (jamais un JSON re-sérialisé, dont l'ordre des clés ou les espaces
 * différeraient).
 */
export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Valeur de l'en-tête `X-Contrats-Signature`. */
export function signatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `${SIGNATURE_VERSION}=${computeSignature(secret, timestamp, rawBody)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

export function verifyWebhookSignature(input: {
  secret: string;
  /** En-tête X-Contrats-Signature reçu (peut contenir plusieurs `vN=` séparés par des virgules). */
  signatureHeader: string | undefined;
  /** En-tête X-Contrats-Timestamp reçu. */
  timestampHeader: string | undefined;
  /** Corps BRUT reçu, tel quel. */
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const { secret, rawBody } = input;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!input.signatureHeader || !input.timestampHeader || !/^\d{1,12}$/.test(input.timestampHeader)) {
    return { ok: false, reason: 'malformed' };
  }
  const ts = Number(input.timestampHeader);
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'stale' };

  const expected = Buffer.from(computeSignature(secret, ts, rawBody), 'hex');
  const candidates = input.signatureHeader
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${SIGNATURE_VERSION}=`))
    .map((p) => p.slice(SIGNATURE_VERSION.length + 1));
  if (candidates.length === 0) return { ok: false, reason: 'malformed' };
  for (const hex of candidates) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    // timingSafeEqual exige deux tampons de même longueur : garanti ici (32 octets).
    if (timingSafeEqual(Buffer.from(hex, 'hex'), expected)) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * Secret d'abonnement : 32 octets aléatoires, préfixés pour être reconnus
 * par un scanner de secrets (`whsec_`). Montré UNE fois (création, rotation).
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
