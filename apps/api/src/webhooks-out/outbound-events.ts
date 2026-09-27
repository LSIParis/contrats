import { publishWebhookEvent, uuidv7 } from '@lsi/persistence';
import { WEBHOOK_EVENT_SCHEMAS, type WebhookEventData, type WebhookEventType } from './events.js';

/**
 * Publication d'un événement sortant — OUTBOX TRANSACTIONNELLE.
 *
 *   await OutboundEvents.publish(tx, { tenantId, customerId, type, resourceId, payload, occurredAt });
 *
 * `tx` est la transaction de la modification métier (celle de `withScope`) :
 * l'événement et ses livraisons PENDING (une par abonnement actif du type)
 * sont écrits DANS cette transaction. Si elle est annulée, rien n'est publié ;
 * si elle est validée, l'événement sera livré — jamais l'un sans l'autre.
 * Aucun appel réseau ici : la livraison est asynchrone (job `webhooks-deliver`
 * toutes les minutes, latence ≤ ~1 min en régime normal).
 *
 * Fonction simple (sans injection) : un producteur n'a besoin que de sa
 * transaction. Le payload est validé par le schéma Zod du type AVANT écriture
 * — un producteur qui publierait un champ non prévu (donnée personnelle…)
 * échoue en test plutôt que de fuiter en production.
 */
export interface PublishInput<T extends WebhookEventType> {
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly type: T;
  readonly resourceId: string | null;
  readonly payload: WebhookEventData<T>;
  readonly occurredAt: Date;
}

export interface PublishResult {
  readonly eventId: string;
  readonly deliveries: number;
}

async function publish<T extends WebhookEventType>(tx: unknown, input: PublishInput<T>): Promise<PublishResult> {
  const payload = WEBHOOK_EVENT_SCHEMAS[input.type].parse(input.payload);
  const eventId = uuidv7();
  const deliveries = await publishWebhookEvent(tx as never, {
    eventId,
    tenantId: input.tenantId,
    customerId: input.customerId,
    type: input.type,
    resourceId: input.resourceId,
    payload,
    occurredAt: input.occurredAt,
  });
  return { eventId, deliveries };
}

export const OutboundEvents = { publish } as const;
