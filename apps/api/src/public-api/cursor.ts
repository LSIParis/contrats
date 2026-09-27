import { BadRequestException } from '@nestjs/common';

/**
 * Curseur de pagination OPAQUE : base64url d'un JSON de clés de tri. Le
 * client ne doit ni le construire ni l'interpréter ; il le renvoie tel quel.
 */
export function encodeCursor(keys: Record<string, string>): string {
  return Buffer.from(JSON.stringify(keys), 'utf8').toString('base64url');
}

export function decodeCursor<K extends string>(cursor: string | undefined, fields: readonly K[]): Record<K, string> | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (fields.every((f) => typeof v[f] === 'string')) return v as Record<K, string>;
  } catch {
    // curseur illisible : même réponse qu'un curseur mal formé
  }
  throw new BadRequestException({ code: 'INVALID_CURSOR', detail: 'Curseur de pagination invalide.' });
}

/** Découpe `limit + 1` lignes lues en une page et son curseur suivant. */
export function page<T>(rows: T[], limit: number, keysOf: (row: T) => Record<string, string>) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? encodeCursor(keysOf(data[data.length - 1]!)) : null };
}
