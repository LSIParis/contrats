import { Injectable, Logger } from '@nestjs/common';
import { findDueWebhookDeliveries, tenantSystemScope, withScope } from '@lsi/persistence';
import { AuditService } from '../audit/audit.service.js';
import { disableAfterDead, MAX_ATTEMPTS, nextAttemptAfterFailure } from './backoff.js';
import { buildEnvelope } from './events.js';
import { postWebhook, type SendResult } from './http-sender.js';
import { decryptSecret, keyRingFromEnv, type KeyRing } from './secret-box.js';
import { signatureHeader } from './signature.js';
import { allowPrivateTargets } from './ssrf.js';

/**
 * Livraison des webhooks sortants. (07-api.md §Webhooks sortants)
 *
 * Déroulé d'une tentative :
 *   1. RÉSERVATION (transaction courte) : la livraison due voit son échéance
 *      repoussée d'un bail (`LEASE_MS`) par un UPDATE conditionnel. Deux
 *      workers (ou deux passages du job) qui la découvrent en même temps ne
 *      l'envoient donc qu'une fois : le second ne met à jour aucune ligne.
 *      Si le processus meurt pendant l'envoi, le bail expire et la livraison
 *      est reprise — sémantique « au moins une fois », d'où la clé
 *      d'idempotence `id` de l'enveloppe côté consommateur.
 *   2. ENVOI hors transaction (jamais d'appel réseau transaction ouverte).
 *   3. ENREGISTREMENT du résultat (transaction courte) : DELIVERED, FAILED
 *      (reprise programmée) ou DEAD ; compteur d'échecs de l'abonnement,
 *      désactivation automatique au seuil, tracée dans l'audit.
 *
 * Ni le secret ni le corps ne sont journalisés : les logs ne portent que des
 * identifiants, un statut HTTP et une durée.
 */
const LEASE_MS = 2 * 60_000; // > délai d'envoi (10 s) avec une large marge
const MAX_ERROR_LENGTH = 500;

export type AttemptOutcome = 'DELIVERED' | 'FAILED' | 'DEAD' | 'SKIPPED';

@Injectable()
export class WebhookDeliveryService {
  private readonly log = new Logger(WebhookDeliveryService.name);
  private readonly ring: KeyRing = keyRingFromEnv();

  constructor(private readonly audit: AuditService) {}

  /** Passage du job `webhooks-deliver` : toutes les livraisons dues, séquentiellement. */
  async deliverDue(now: () => Date = () => new Date()): Promise<Record<AttemptOutcome, number>> {
    const out: Record<AttemptOutcome, number> = { DELIVERED: 0, FAILED: 0, DEAD: 0, SKIPPED: 0 };
    for (const ref of await findDueWebhookDeliveries(200)) {
      try {
        out[await this.attempt(ref.tenantId, ref.id, now())]++;
      } catch (err) {
        // Une livraison en erreur inattendue ne bloque pas les suivantes ;
        // son bail expirera et elle sera reprise.
        this.log.error(`livraison ${ref.id} : erreur inattendue (${(err as Error).name})`);
      }
    }
    return out;
  }

  /**
   * Une tentative de livraison. `force` (relivraison manuelle, test) ignore
   * l'échéance mais pas l'état : seule une livraison réservée est envoyée.
   */
  async attempt(tenantId: string, deliveryId: string, now: Date): Promise<AttemptOutcome> {
    const scope = tenantSystemScope(tenantId);

    // 1. Réservation.
    const claimed = await withScope(scope, async (tx) => {
      const r = await tx.webhookDelivery.updateMany({
        where: {
          id: deliveryId,
          status: { in: ['PENDING', 'FAILED'] },
          nextAttemptAt: { lte: now },
          subscription: { active: true },
        },
        data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS), updatedAt: now },
      });
      if (r.count !== 1) return null;
      return tx.webhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        include: { event: true, subscription: true },
      });
    });
    if (!claimed) return 'SKIPPED';

    const { event, subscription } = claimed;
    const attempt = claimed.attempt + 1;

    // 2. Envoi. Le corps est sérialisé UNE fois : c'est ce texte exact qui est signé.
    const body = JSON.stringify(
      buildEnvelope({ id: event.id, type: event.type, occurredAt: event.occurredAt, payload: event.payload }),
    );
    const timestamp = Math.floor(now.getTime() / 1000);
    let result: SendResult | null = null;
    let error: string | null = null;
    try {
      const secret = decryptSecret(this.ring, subscription.id, subscription.secretCiphertext, subscription.secretKeyVersion);
      result = await postWebhook(
        subscription.url,
        {
          'Content-Type': 'application/json',
          'User-Agent': 'LSI-Contrats-Webhooks/1',
          'X-Contrats-Event': event.type,
          'X-Contrats-Delivery': claimed.id,
          'X-Contrats-Timestamp': String(timestamp),
          'X-Contrats-Signature': signatureHeader(secret, timestamp, body),
        },
        body,
        { allowPrivate: allowPrivateTargets() },
      );
      if (result.status < 200 || result.status >= 300) {
        error = result.status >= 300 && result.status < 400
          ? `HTTP ${result.status} : redirection non suivie`
          : `HTTP ${result.status} ${result.snippet}`;
      }
    } catch (err) {
      error = `${(err as Error).name}: ${(err as Error).message}`;
    }

    // 3. Enregistrement.
    const done = new Date();
    if (!error) {
      await withScope(scope, async (tx) => {
        await tx.webhookDelivery.update({
          where: { id: claimed.id },
          data: {
            status: 'DELIVERED', attempt, nextAttemptAt: null, deliveredAt: done,
            responseStatus: result!.status, responseMs: result!.ms, lastError: null, updatedAt: done,
          },
        });
        await tx.webhookSubscription.update({
          where: { id: subscription.id },
          data: { consecutiveFailures: 0, updatedAt: done },
        });
      });
      this.log.log(`livraison ${claimed.id} (${event.type}) : HTTP ${result!.status} en ${result!.ms} ms`);
      return 'DELIVERED';
    }

    const next = nextAttemptAfterFailure(attempt, done);
    const status = next ? 'FAILED' : 'DEAD';
    const threshold = disableAfterDead();
    const disabled = await withScope(scope, async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: claimed.id },
        data: {
          status, attempt, nextAttemptAt: next,
          responseStatus: result?.status ?? null, responseMs: result?.ms ?? null,
          lastError: truncate(error!), updatedAt: done,
        },
      });
      if (status !== 'DEAD') return false;
      const sub = await tx.webhookSubscription.update({
        where: { id: subscription.id },
        data: { consecutiveFailures: { increment: 1 }, updatedAt: done },
      });
      if (!sub.active || sub.consecutiveFailures < threshold) return false;
      await tx.webhookSubscription.update({
        where: { id: subscription.id },
        data: {
          active: false, disabledAt: done, updatedAt: done,
          disabledReason: `désactivé automatiquement après ${sub.consecutiveFailures} livraisons en échec définitif consécutives`,
        },
      });
      return true;
    });
    this.log.warn(`livraison ${claimed.id} (${event.type}) : tentative ${attempt}/${MAX_ATTEMPTS} en échec → ${status}`);

    if (disabled) {
      this.log.warn(`abonnement ${subscription.id} désactivé automatiquement (seuil ${threshold})`);
      await this.audit.record({
        tenantId, customerId: null, actorUserId: null, actorKind: 'SYSTEM', actorIp: null, actorUserAgent: null,
        action: 'webhook.subscription.auto_disabled', resourceType: 'webhooks', resourceId: subscription.id,
        after: { threshold, lastDeliveryId: claimed.id }, requestId: null, occurredAt: done,
      });
    }
    return status;
  }
}

function truncate(s: string): string {
  // Pas de retour à la ligne ni de caractère de contrôle dans un message stocké.
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH - 1)}…` : clean;
}
