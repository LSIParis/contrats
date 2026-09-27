import { ConflictException } from '@nestjs/common';
import { setTransitionContext } from '@lsi/persistence';
import {
  applyProposalEvent,
  ProposalRuleError,
  ProposalTransitionError,
  type ProposalEvent,
  type ProposalSnapshot,
  type ProposalStatus,
} from '@lsi/domain';
import { ProposalEventDataSchema, type WebhookEventType } from '../webhooks-out/events.js';
import { OutboundEvents } from '../webhooks-out/outbound-events.js';

/**
 * Écriture d'une transition de proposition — LE seul chemin (même principe
 * que `contracts/snapshot.ts` → `persistTransition`) :
 *
 *   1. la machine du domaine décide (`applyProposalEvent`) ;
 *   2. le contexte (événement, motif) est posé pour le trigger
 *      `proposals_status_transition` → proposal_lifecycle_events + audit chaîné ;
 *   3. l'état renvoyé par la machine est écrit, avec les horodatages métier ;
 *   4. l'événement sortant `proposal.*` est publié DANS la même transaction
 *      (outbox) : aucune transition n'échappe ni au journal ni aux webhooks.
 */

/** Statut d'arrivée → événement sortant (brief §12.9). */
const PROPOSAL_STATUS_EVENTS: Partial<Record<ProposalStatus, WebhookEventType>> = {
  SENT: 'proposal.sent',
  VIEWED: 'proposal.viewed',
  ACCEPTED: 'proposal.accepted',
  SIGNED: 'proposal.signed',
  DECLINED: 'proposal.declined',
  EXPIRED: 'proposal.expired',
  CONVERTED: 'proposal.converted',
};

/** Ligne `proposals` (Prisma) + compteurs de préparation → snapshot du domaine. */
export interface ReadinessCounters {
  readonly hasRecipients: boolean;
  readonly hasSigner: boolean;
  readonly unresolvedMergeTags: number;
  readonly blockingValidations: number;
  readonly pricingErrors: number;
  readonly reviewRequired: boolean;
}

export const NEUTRAL_READINESS: ReadinessCounters = {
  hasRecipients: true,
  hasSigner: true,
  unresolvedMergeTags: 0,
  blockingValidations: 0,
  pricingErrors: 0,
  reviewRequired: false,
};

export function toProposalSnapshot(p: any, r: ReadinessCounters = NEUTRAL_READINESS): ProposalSnapshot {
  return {
    id: p.id,
    status: p.status,
    currentVersionId: p.currentVersionId,
    acceptanceMode: p.acceptanceMode,
    expiresAt: p.expiresAt,
    reviewRequired: r.reviewRequired,
    reviewSubmittedByUserId: p.reviewSubmittedByUserId,
    reviewApprovedVersionId: p.reviewApprovedVersionId,
    acceptedVersionId: p.acceptedVersionId,
    hasRecipients: r.hasRecipients,
    hasSigner: r.hasSigner,
    unresolvedMergeTags: r.unresolvedMergeTags,
    blockingValidations: r.blockingValidations,
    pricingErrors: r.pricingErrors,
  };
}

/** Erreurs du domaine → 409 / 422 explicites (jamais un 500). */
export function domainError(e: unknown): never {
  if (e instanceof ProposalTransitionError) {
    throw new ConflictException({
      code: e.code,
      detail: e.message,
      currentStatus: e.currentStatus,
      allowedTransitions: e.allowedTransitions,
    });
  }
  if (e instanceof ProposalRuleError) {
    throw new ConflictException({ code: e.code, rule: e.rule, detail: e.message });
  }
  throw e;
}

/** Horodatages métier posés à l'arrivée dans un statut. */
function stampsFor(status: ProposalStatus, now: Date): Record<string, Date> {
  switch (status) {
    case 'SENT':
      return { sentAt: now };
    case 'VIEWED':
      return {};
    case 'ACCEPTED':
      return { acceptedAt: now };
    case 'SIGNED':
      return { signedAt: now };
    case 'CONVERTED':
      return { convertedAt: now };
    case 'DECLINED':
      return { declinedAt: now };
    case 'EXPIRED':
      return { expiredAt: now };
    case 'WITHDRAWN':
      return { withdrawnAt: now };
    default:
      return {};
  }
}

export interface TransitionOptions {
  readonly now: Date;
  /** Acteur interne (colonne updated_by) ; omis pour le système et la page publique. */
  readonly userId?: string | null;
  readonly readiness?: ReadinessCounters;
  /** Colonnes métier supplémentaires écrites avec la transition. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Applique `event` à la proposition `proposalId` (lue dans `tx`) et persiste
 * le résultat. Renvoie la ligne mise à jour. Lève 409 si la machine refuse.
 */
export async function persistProposalTransition(tx: any, proposalId: string, event: ProposalEvent, opts: TransitionOptions) {
  const before = await tx.proposal.findUnique({
    where: { id: proposalId },
    include: { customer: { select: { externalRef: true } } },
  });
  if (!before) throw new ConflictException({ code: 'PROPOSAL_NOT_FOUND', detail: 'Proposition introuvable.' });

  let next: ProposalSnapshot;
  try {
    next = applyProposalEvent(toProposalSnapshot(before, opts.readiness), event, opts.now);
  } catch (e) {
    domainError(e);
  }

  const reason =
    'reason' in event && typeof event.reason === 'string'
      ? event.reason.trim() || null
      : event.type === 'DECLINE'
        ? event.reasonCode
        : null;
  await setTransitionContext(tx, { event: event.type, reason });

  const updated = await tx.proposal.update({
    where: { id: proposalId },
    data: {
      status: next.status,
      expiresAt: next.expiresAt,
      reviewSubmittedByUserId: next.reviewSubmittedByUserId,
      reviewApprovedVersionId: next.reviewApprovedVersionId,
      acceptedVersionId: next.acceptedVersionId,
      ...(next.status !== before.status ? stampsFor(next.status, opts.now) : {}),
      ...(opts.extra ?? {}),
      updatedAt: opts.now,
      ...(opts.userId ? { updatedByUserId: opts.userId } : {}),
    },
  });

  const type = next.status !== before.status ? PROPOSAL_STATUS_EVENTS[next.status] : undefined;
  if (type) {
    const version = updated.currentVersionId
      ? await tx.proposalVersion.findUnique({ where: { id: updated.currentVersionId }, select: { versionNumber: true } })
      : null;
    await OutboundEvents.publish(tx, {
      tenantId: updated.tenantId,
      customerId: updated.customerId,
      type,
      resourceId: updated.id,
      payload: ProposalEventDataSchema.parse({
        proposal: {
          id: updated.id,
          number: updated.number,
          status: updated.status,
          previousStatus: before.status,
          customerId: updated.customerId,
          customerExternalRef: before.customer?.externalRef ?? null,
          versionNumber: version?.versionNumber ?? null,
          expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
          declineReasonCode: updated.declineReasonCode && /^[A-Z_]{2,40}$/.test(updated.declineReasonCode) ? updated.declineReasonCode : null,
          contractId: updated.contractId ?? null,
        },
      }),
      occurredAt: opts.now,
    });
  }
  return updated;
}
