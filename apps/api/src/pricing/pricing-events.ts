import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';

/**
 * Événement de domaine `pricing.revised` (brief §8 : webhook sortant du même
 * nom, livré au lot API publique).
 *
 * Émis APRÈS commit, quand le prix d'un contrat change pour l'avenir :
 *  - activation d'une nouvelle version de barème (révision, avenant tarifaire) ;
 *  - dérogation devenue applicable (créée sous le seuil, ou validée) ;
 *  - annulation d'une dérogation applicable.
 *
 * Deux sorties, découplées :
 *  1. une entrée `pricing.revised` dans la piste d'audit CHAÎNÉE — trace
 *     durable et requêtable, qui servira de source (outbox) au lot webhooks ;
 *  2. les abonnés en mémoire (`onPricingRevised`) — le point de branchement
 *     du futur `WebhookDispatcher`. Un abonné en erreur ne casse ni la
 *     requête (déjà commitée) ni les autres abonnés.
 */
export type PricingRevisedCause = 'SCHEDULE_ACTIVATED' | 'OVERRIDE_EFFECTIVE' | 'OVERRIDE_CANCELLED';

export interface PricingRevisedEvent {
  readonly type: 'pricing.revised';
  readonly tenantId: string;
  readonly customerId: string;
  readonly contractId: string;
  readonly cause: PricingRevisedCause;
  /** Premier jour (YYYY-MM-DD) où le nouveau prix s'applique. */
  readonly effectiveFrom: string;
  readonly scheduleId?: string;
  readonly scheduleVersion?: number;
  readonly overrideId?: string;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export type PricingRevisedListener = (e: PricingRevisedEvent) => void | Promise<void>;

@Injectable()
export class PricingEvents {
  private readonly log = new Logger(PricingEvents.name);
  private readonly listeners = new Set<PricingRevisedListener>();

  constructor(private readonly audit: AuditService) {}

  /** Abonnement ; renvoie la fonction de désabonnement. */
  onPricingRevised(listener: PricingRevisedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(e: PricingRevisedEvent): Promise<void> {
    await this.audit.record({
      tenantId: e.tenantId,
      customerId: e.customerId,
      actorUserId: e.actorUserId,
      actorKind: e.actorUserId ? 'INTERNAL' : 'SYSTEM',
      actorIp: null,
      actorUserAgent: null,
      action: 'pricing.revised',
      resourceType: 'contract',
      resourceId: e.contractId,
      after: e,
      requestId: null,
      occurredAt: new Date(e.occurredAt),
    });
    for (const l of this.listeners) {
      try {
        await l(e);
      } catch (err) {
        this.log.error(`abonné pricing.revised en erreur : ${(err as Error).message}`);
      }
    }
  }
}
