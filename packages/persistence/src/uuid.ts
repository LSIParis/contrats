import { randomUUID } from 'node:crypto';

/**
 * UUIDv7 — ordonné dans le temps (index performants) et non énumérable (§10.6).
 *
 * Implémentation minimale : 48 bits de timestamp ms + 74 bits aléatoires,
 * conforme RFC 9562 §5.7.
 */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');

  // 48 bits de timestamp big-endian
  bytes.writeUIntBE(ts, 0, 6);

  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant RFC 4122
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
