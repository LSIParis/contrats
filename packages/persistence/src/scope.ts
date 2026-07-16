/**
 * Le scope d'une unité de travail. (§10.4)
 *
 * Un Scope n'est JAMAIS construit depuis une entrée utilisateur (RM-29).
 * Il est résolu côté serveur à l'ouverture de session, ou dérivé en base
 * pour les traitements système (webhooks, jobs).
 */
export type ActorKind = 'INTERNAL' | 'CLIENT' | 'SYSTEM';

export interface Scope {
  readonly tenantId: string;
  /** Clients explicitement autorisés. Ignoré si allCustomers est vrai. */
  readonly customerIds: readonly string[];
  /** Vrai pour MSP_ADMIN et LEGAL_REVIEWER uniquement. */
  readonly allCustomers: boolean;
  readonly userId: string;
  readonly actorKind: ActorKind;
}

/** Interne à portefeuille restreint : ACCOUNT_MANAGER, TECHNICIAN. */
export function internalScope(
  tenantId: string,
  customerIds: readonly string[],
  userId = 'system',
): Scope {
  return { tenantId, customerIds, allCustomers: false, userId, actorKind: 'INTERNAL' };
}

/** Interne transverse : MSP_ADMIN, LEGAL_REVIEWER. */
export function adminScope(tenantId: string, userId = 'system'): Scope {
  return { tenantId, customerIds: [], allCustomers: true, userId, actorKind: 'INTERNAL' };
}

/**
 * Session client : TOUJOURS un singleton (RM-31).
 * La signature interdit de passer plusieurs clients.
 */
export function clientScope(tenantId: string, customerId: string, userId: string): Scope {
  return {
    tenantId,
    customerIds: [customerId],
    allCustomers: false,
    userId,
    actorKind: 'CLIENT',
  };
}

/**
 * Scope système, pour les webhooks et jobs.
 *
 * Prend un customerId unique et obligatoire : un traitement système
 * n'a jamais de raison légitime d'opérer sur « tous les clients ».
 * Le scope vient de NOTRE base, jamais d'un payload (§11.4).
 */
export function systemScope(tenantId: string, customerId: string): Scope {
  return {
    tenantId,
    customerIds: [customerId],
    allCustomers: false,
    userId: 'system',
    actorKind: 'SYSTEM',
  };
}
