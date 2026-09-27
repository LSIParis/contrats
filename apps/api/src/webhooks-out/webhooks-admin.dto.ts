import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './events.js';

/**
 * Schémas d'entrée de l'administration des webhooks. Réutilisés tels quels
 * par l'API publique (scope `webhooks:manage`, lot 7) et son OpenAPI.
 * `.strict()` : un champ inconnu (tenantId…) fait échouer la requête.
 */
const eventTypes = z
  .array(z.enum(WEBHOOK_EVENT_TYPES as [WebhookEventType, ...WebhookEventType[]]))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .transform((a) => [...new Set(a)]);

export const CreateWebhookBody = z
  .object({
    url: z.string().trim().min(8).max(2048),
    description: z.string().trim().max(500).optional(),
    eventTypes,
  })
  .strict();
export type CreateWebhookInput = z.infer<typeof CreateWebhookBody>;

export const ListDeliveriesQuery = z
  .object({
    status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'DEAD']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListDeliveriesInput = z.infer<typeof ListDeliveriesQuery>;
