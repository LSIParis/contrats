import type { Prisma } from '@prisma/client';
import { unsafeUnscopedClient } from './scoped-client.js';

/**
 * Outbox des webhooks sortants (migration 23, docs/contrats/07-api.md).
 *
 * `publishWebhookEvent` s'exécute DANS la transaction de l'appelant (`tx`
 * fourni par `withScope`) : l'événement et ses livraisons PENDING sont validés
 * ou annulés AVEC la modification métier — un événement existe si et
 * seulement si le changement a été commité (patron « transactional outbox »).
 *
 * La fonction SQL `app_publish_webhook_event` est SECURITY DEFINER : elle
 * écrit même quand la transaction est ouverte au nom d'un CLIENT (portail),
 * sans lui ouvrir la lecture des tables webhook_* (RLS). Elle refuse un tenant
 * autre que celui de la transaction et un client hors scope.
 */
export interface WebhookEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly type: string;
  readonly resourceId: string | null;
  readonly payload: unknown;
  readonly occurredAt: Date;
  /** Cible unique (événement `ping` de test) ; sinon diffusion aux abonnés du type. */
  readonly onlySubscriptionId?: string | null;
}

/** Écrit l'événement dans l'outbox ; renvoie le nombre de livraisons créées. */
export async function publishWebhookEvent(
  tx: Prisma.TransactionClient,
  e: WebhookEventInput,
): Promise<number> {
  // Nom de fonction littéral, paramètres liés (§13.3). L'instant passe en ISO
  // et est ramené en UTC SANS fuseau (convention Prisma des colonnes
  // timestamp(3)), indépendamment du TimeZone de la session.
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT app_publish_webhook_event(
      ${e.eventId}::uuid, ${e.tenantId}::uuid, ${e.customerId}::uuid, ${e.type}::text,
      ${e.resourceId}::uuid, ${JSON.stringify(e.payload)}::jsonb,
      (${e.occurredAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
      ${e.onlySubscriptionId ?? null}::uuid) AS n`;
  return Number(rows[0]?.n ?? 0);
}

export interface DueWebhookDeliveryRef {
  readonly id: string;
  readonly tenantId: string;
}

/**
 * Livraisons dues (PENDING/FAILED dont l'échéance est passée, abonnement
 * actif). Lecture hors scope VOLONTAIRE via une fonction SECURITY DEFINER qui
 * ne renvoie que des identifiants (patron `lifecycle-lookup.ts`) ; la
 * livraison elle-même se fait ensuite dans le scope système du tenant.
 */
export async function findDueWebhookDeliveries(limit = 100): Promise<DueWebhookDeliveryRef[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<{ id: string; tenant_id: string }[]>`
    SELECT * FROM app_find_due_webhook_deliveries(${limit}::int)`;
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}
