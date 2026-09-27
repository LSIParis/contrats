import type { ContractStatus } from '@lsi/domain';
import { buildContractEventData, type ContractRowForEvent, type WebhookEventType } from './events.js';
import { OutboundEvents } from './outbound-events.js';

/**
 * Producteurs `contract.*` : statut d'ARRIVÉE → type d'événement publié.
 *
 * UNE table, lue par `persistTransition` (contracts/snapshot.ts), seul
 * endroit où un statut de contrat est écrit : aucune transition n'échappe
 * donc à la publication, qu'elle vienne d'une requête, d'un webhook DocuSeal
 * ou d'un job. Étendre = ajouter une ligne (et le type dans events.ts).
 */
export const CONTRACT_STATUS_EVENTS: Partial<Record<ContractStatus, WebhookEventType>> = {
  SIGNED: 'contract.signed',
  ACTIVE: 'contract.activated',
  RENEWAL_DUE: 'contract.renewal_due',
  RENEWED: 'contract.renewed',
  TERMINATED: 'contract.terminated',
};

export function contractEventFor(status: string): WebhookEventType | undefined {
  return CONTRACT_STATUS_EVENTS[status as ContractStatus];
}

/**
 * Publie l'événement d'une transition, DANS la transaction `tx` de la
 * transition (outbox). Sans effet si le statut ne change pas ou n'est pas
 * dans la table. `after` est la ligne `contracts` telle que mise à jour.
 */
export async function publishContractTransition(
  tx: any,
  previousStatus: string | null,
  after: ContractRowForEvent & { tenantId: string },
  customerExternalRef: string | null,
  now: Date,
): Promise<void> {
  const type = contractEventFor(after.status);
  if (!type || previousStatus === after.status) return;
  await OutboundEvents.publish(tx, {
    tenantId: after.tenantId,
    customerId: after.customerId,
    type,
    resourceId: after.id,
    payload: buildContractEventData(after, previousStatus, customerExternalRef),
    occurredAt: now,
  });
}
