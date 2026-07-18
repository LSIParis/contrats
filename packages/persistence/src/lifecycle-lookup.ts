import { unsafeUnscopedClient } from './scoped-client.js';

export interface ScopeRef {
  readonly id: string;
  readonly tenantId: string;
  readonly customerId: string;
}

/**
 * Découverte des contrats dont le cycle de vie doit avancer. (RM-06, RM-07)
 *
 * Lectures hors scope volontaires, via fonctions SECURITY DEFINER bornées :
 * on cherche DE QUEL scope relève chaque contrat à faire évoluer. Ne renvoient
 * que des identifiants, jamais de contenu — le traitement se fait ensuite dans
 * le scope résolu, sous RLS.
 */
async function discover(fn: string, limit: number): Promise<ScopeRef[]> {
  // ::int car Prisma passe un number JS en bigint, et la fonction attend int.
  const rows = await unsafeUnscopedClient.$queryRawUnsafe<
    { id: string; tenant_id: string; customer_id: string }[]
  >(`SELECT * FROM ${fn}($1::int)`, limit);
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, customerId: r.customer_id }));
}

/** Signés dont la date de début est atteinte (RM-06). */
export function findContractsToActivate(limit = 500): Promise<ScopeRef[]> {
  return discover('app_find_contracts_to_activate', limit);
}

/** Actifs dont le terme est dépassé (RM-07). */
export function findContractsToExpire(limit = 500): Promise<ScopeRef[]> {
  return discover('app_find_contracts_to_expire', limit);
}
