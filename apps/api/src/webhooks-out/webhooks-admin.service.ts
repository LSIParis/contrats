import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { publishWebhookEvent, uuidv7, withScope, type Scope } from '@lsi/persistence';
import { PingDataSchema, WEBHOOK_EVENT_TYPES } from './events.js';
import { encryptSecret, keyRingFromEnv, type KeyRing } from './secret-box.js';
import { generateWebhookSecret } from './signature.js';
import { UnsafeWebhookTargetError, validateWebhookUrl } from './ssrf.js';
import { WebhookDeliveryService, type AttemptOutcome } from './webhook-delivery.service.js';
import type { CreateWebhookInput, ListDeliveriesInput } from './webhooks-admin.dto.js';

/**
 * Administration des abonnements aux webhooks sortants.
 *
 * Service RÉUTILISABLE : il ne connaît que le `Scope` (RLS) et des entrées
 * déjà validées. Le contrôleur interne (`/v1/admin/webhooks`, permission
 * `webhooks.manage`) l'utilise aujourd'hui ; l'API publique (scope
 * `webhooks:manage`, lot 7) s'y branchera sans rien dupliquer.
 *
 * Le tenant vient TOUJOURS du scope, jamais d'un paramètre. Un identifiant
 * d'un autre tenant est invisible (RLS) : 404, pas 403 — on ne confirme pas
 * l'existence d'une ressource étrangère.
 *
 * LE SECRET n'est renvoyé qu'à la création et à la rotation, une seule fois ;
 * il n'est stocké que chiffré (secret-box.ts). Aucune autre réponse ne le
 * contient, pas même chiffré (`secretCiphertext` n'est jamais sélectionné).
 */
const PUBLIC_FIELDS = {
  id: true, url: true, description: true, eventTypes: true, secretHint: true, active: true,
  consecutiveFailures: true, disabledAt: true, disabledReason: true, createdByUserId: true,
  createdAt: true, updatedAt: true,
} as const;

const userOrNull = (scope: Scope): string | null => (scope.userId === 'system' ? null : scope.userId);
const hintOf = (secret: string): string => secret.slice(-4);

@Injectable()
export class WebhooksAdminService {
  private readonly ring: KeyRing = keyRingFromEnv();

  constructor(private readonly delivery: WebhookDeliveryService) {}

  eventTypes(): readonly string[] {
    return WEBHOOK_EVENT_TYPES;
  }

  async list(scope: Scope) {
    return withScope(scope, (tx) =>
      tx.webhookSubscription.findMany({ where: { tenantId: scope.tenantId }, select: PUBLIC_FIELDS, orderBy: { createdAt: 'asc' } }),
    );
  }

  async create(scope: Scope, input: CreateWebhookInput, now: Date) {
    const url = this.safeUrl(input.url);
    const id = uuidv7();
    const secret = generateWebhookSecret();
    const { ciphertext, keyVersion } = encryptSecret(this.ring, id, secret);
    const sub = await withScope(scope, (tx) =>
      tx.webhookSubscription.create({
        data: {
          id, tenantId: scope.tenantId, url, description: input.description ?? null, eventTypes: input.eventTypes,
          secretCiphertext: ciphertext, secretKeyVersion: keyVersion, secretHint: hintOf(secret),
          createdByUserId: userOrNull(scope), createdAt: now, updatedAt: now,
        },
        select: PUBLIC_FIELDS,
      }),
    );
    return { ...sub, secret };
  }

  async rotateSecret(scope: Scope, id: string, now: Date) {
    const secret = generateWebhookSecret();
    const { ciphertext, keyVersion } = encryptSecret(this.ring, id, secret);
    const sub = await withScope(scope, async (tx) => {
      await this.mustExist(tx, id);
      return tx.webhookSubscription.update({
        where: { id },
        data: { secretCiphertext: ciphertext, secretKeyVersion: keyVersion, secretHint: hintOf(secret), updatedAt: now },
        select: PUBLIC_FIELDS,
      });
    });
    return { ...sub, secret };
  }

  async setActive(scope: Scope, id: string, active: boolean, now: Date) {
    return withScope(scope, async (tx) => {
      await this.mustExist(tx, id);
      return tx.webhookSubscription.update({
        where: { id },
        data: active
          // Réactivation : on repart d'un compteur vierge, sinon une seule
          // nouvelle livraison morte redésactiverait aussitôt.
          ? { active: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0, updatedAt: now }
          : { active: false, disabledAt: now, disabledReason: 'désactivé par un administrateur', updatedAt: now },
        select: PUBLIC_FIELDS,
      });
    });
  }

  async deliveries(scope: Scope, id: string, q: ListDeliveriesInput) {
    return withScope(scope, async (tx) => {
      await this.mustExist(tx, id);
      const rows = await tx.webhookDelivery.findMany({
        where: { subscriptionId: id, ...(q.status ? { status: q.status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: { event: { select: { id: true, type: true, occurredAt: true, resourceId: true } } },
      });
      return rows.map((d) => ({
        id: d.id, status: d.status, attempt: d.attempt, nextAttemptAt: d.nextAttemptAt,
        responseStatus: d.responseStatus, responseMs: d.responseMs, lastError: d.lastError,
        deliveredAt: d.deliveredAt, createdAt: d.createdAt, event: d.event,
      }));
    });
  }

  /** Envoie un `ping` à CET abonnement, tout de suite, et renvoie le résultat. */
  async test(scope: Scope, id: string, now: Date): Promise<{ deliveryId: string; outcome: AttemptOutcome }> {
    const deliveryId = await withScope(scope, async (tx) => {
      const sub = await this.mustExist(tx, id);
      if (!sub.active) throw new ConflictException('Abonnement désactivé : réactivez-le avant de le tester.');
      const eventId = uuidv7();
      await publishWebhookEvent(tx, {
        eventId, tenantId: scope.tenantId, customerId: null, type: 'ping', resourceId: null,
        payload: PingDataSchema.parse({ subscriptionId: id, message: 'ping' }), occurredAt: now,
        onlySubscriptionId: id,
      });
      const d = await tx.webhookDelivery.findFirstOrThrow({ where: { eventId, subscriptionId: id }, select: { id: true } });
      return d.id;
    });
    return { deliveryId, outcome: await this.delivery.attempt(scope.tenantId, deliveryId, now, { force: true }) };
  }

  /**
   * Relivraison manuelle (DEAD, FAILED ou même DELIVERED) : la livraison
   * repart pour une série complète de tentatives, la première immédiatement.
   */
  async redeliver(scope: Scope, deliveryId: string, now: Date): Promise<{ deliveryId: string; outcome: AttemptOutcome }> {
    await withScope(scope, async (tx) => {
      const d = await tx.webhookDelivery.findFirst({
        where: { id: deliveryId, tenantId: scope.tenantId },
        include: { subscription: { select: { active: true } } },
      });
      if (!d) throw new NotFoundException('Livraison introuvable');
      if (!d.subscription.active) throw new ConflictException('Abonnement désactivé : réactivez-le avant de relivrer.');
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'PENDING', attempt: 0, nextAttemptAt: now, deliveredAt: null, updatedAt: now },
      });
    });
    return { deliveryId, outcome: await this.delivery.attempt(scope.tenantId, deliveryId, now, { force: true }) };
  }

  private async mustExist(tx: any, id: string): Promise<{ id: string; active: boolean }> {
    const sub = await tx.webhookSubscription.findFirst({ where: { id }, select: { id: true, active: true } });
    if (!sub) throw new NotFoundException('Abonnement introuvable');
    return sub;
  }

  private safeUrl(raw: string): string {
    try {
      return validateWebhookUrl(raw);
    } catch (e) {
      if (e instanceof UnsafeWebhookTargetError) throw new BadRequestException(`URL refusée : ${e.message}`);
      throw e;
    }
  }
}
