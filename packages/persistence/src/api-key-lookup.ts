import { unsafeUnscopedClient } from './scoped-client.js';

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
}

/**
 * Résolution d'une clé d'API publique par son préfixe, AVANT tout scope
 * (la requête n'a pas encore de tenant). Fonction SECURITY DEFINER bornée :
 * une ligne au plus, clés actives de tenants actifs seulement. Le hachage
 * est comparé par l'appelant, à temps constant.
 */
export async function resolveApiKeyPrefix(prefix: string): Promise<ResolvedApiKey | null> {
  const rows = await unsafeUnscopedClient.$queryRaw<
    { id: string; tenant_id: string; key_hash: string; scopes: string[]; rate_limit_per_minute: number }[]
  >`SELECT * FROM app_resolve_api_key(${prefix})`;
  const r = rows[0];
  return r ? { id: r.id, tenantId: r.tenant_id, keyHash: r.key_hash, scopes: r.scopes, rateLimitPerMinute: r.rate_limit_per_minute } : null;
}
