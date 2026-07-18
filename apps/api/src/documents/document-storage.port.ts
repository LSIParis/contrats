export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export interface ObjectScope {
  readonly tenantId: string;
  readonly customerId: string;
}

/**
 * Stockage documentaire. (§10.7)
 *
 * En AWS, l'isolation reposait sur SSE-KMS + encryption context {tenant,
 * customer} : un objet chiffré pour le client A ne se déchiffre pas avec le
 * contexte de B, cryptographiquement. Sur OVH/MinIO, ce liage crypto n'existe
 * pas (voir plan de déploiement §1). L'isolation retombe donc sur :
 *   - le PRÉFIXE de chemin scopé (t/{tenant}/c/{customer}/…)
 *   - assertKeyMatchesScope, qui refuse toute clé hors du scope demandé
 *   - le chiffrement au repos du bucket
 *   - et, en amont, RLS
 *
 * On perd la garantie « survit à une erreur de code » du contexte KMS, mais
 * assertKeyMatchesScope attrape le bug de clé mal construite. Assumé et
 * documenté.
 */
export interface DocumentStorage {
  put(key: string, data: Buffer, scope: ObjectScope, contentType?: string): Promise<void>;
  get(key: string, scope: ObjectScope): Promise<Buffer | null>;
  /** URL présignée à durée courte (§10.7) : jamais d'URL S3 durable en base. */
  presignedGetUrl(key: string, scope: ObjectScope, ttlSeconds: number): Promise<string>;
}

/**
 * La clé DOIT porter le scope qu'elle prétend.
 *
 * C'est le garde-fou qui remplace, côté application, la garantie que KMS
 * offrait côté crypto : un bug qui construit `…/c/{autre}/…` pendant qu'on est
 * dans le scope courant est refusé ici, avant tout accès au stockage.
 */
export function assertKeyMatchesScope(key: string, scope: ObjectScope): void {
  const expected = `t/${scope.tenantId}/c/${scope.customerId}/`;
  if (!key.startsWith(expected)) {
    throw new Error(`Clé ${key} incohérente avec le scope ${expected}`);
  }
}
