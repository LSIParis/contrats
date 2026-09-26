/**
 * Passage en JSON des résultats du moteur.
 *
 * Les montants sont des `bigint` (centimes) : JSON.stringify les refuse
 * (TypeError), ce qui est voulu — une conversion implicite en `number`
 * pourrait perdre des centimes au-delà de 2^53. La conversion est donc
 * EXPLICITE : chaque bigint devient une chaîne décimale (« 128867 »). L'API
 * publique documente ces champs comme des chaînes d'entiers en centimes.
 */

export type Jsonified<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Jsonified<T[K]> }
      : T;

export function toJsonSafe<T>(value: T): Jsonified<T> {
  return convert(value) as Jsonified<T>;
}

function convert(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(convert);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = convert(x);
    return out;
  }
  return v;
}
