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
 *
 * Deux fonctions distinctes plutôt qu'un nom paramétré : le tag `$queryRaw`
 * paramètre la limite, et le nom de la fonction reste un littéral — jamais
 * d'interpolation de chaîne (§13.3).
 */
function toRef(r: { id: string; tenant_id: string; customer_id: string }): ScopeRef {
  return { id: r.id, tenantId: r.tenant_id, customerId: r.customer_id };
}

/** Signés dont la date de début est atteinte (RM-06). */
export async function findContractsToActivate(limit = 500): Promise<ScopeRef[]> {
  // ::int car Prisma passe un number JS en bigint, et la fonction attend int.
  const rows = await unsafeUnscopedClient.$queryRaw<
    { id: string; tenant_id: string; customer_id: string }[]
  >`SELECT * FROM app_find_contracts_to_activate(${limit}::int)`;
  return rows.map(toRef);
}

/** Actifs dont le terme est dépassé (RM-07). */
export async function findContractsToExpire(limit = 500): Promise<ScopeRef[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<
    { id: string; tenant_id: string; customer_id: string }[]
  >`SELECT * FROM app_find_contracts_to_expire(${limit}::int)`;
  return rows.map(toRef);
}
