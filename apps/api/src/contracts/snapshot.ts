import { setTransitionContext } from '@lsi/persistence';
import type { ContractEvent, ContractSnapshot } from '@lsi/domain';

/**
 * Frontière contrat Prisma ↔ snapshot du domaine, et écriture d'une transition.
 *
 * AVANT : trois copies divergentes (service, webhook, job) construisaient
 * chacune « leur » snapshot, et deux services écrivaient un statut EN DUR
 * après avoir consulté la machine (`status: 'TERMINATED'`) — la machine
 * validait, mais ne décidait pas. Désormais l'état persisté est TOUJOURS
 * l'état renvoyé par `applyEvent`, via `persistTransition`.
 */

const CLOSED_AMENDMENT = ['CANCELLED', 'DECLINED', 'TERMINATED', 'EXPIRED', 'RENEWED'];

export interface SnapshotExtras {
  /** RM-10 : auteur de la soumission en cours (null si aucune). */
  readonly submittedByUserId?: string | null;
  /** RM-07 : successeur de renouvellement effectivement SIGNÉ. */
  readonly hasSignedSuccessor?: boolean;
}

/**
 * `c` est la ligne `contracts` (avec, si chargés, `signers` et `amendments`).
 * Sans `signers` chargés, les gardes « signataires » sont considérées comme
 * satisfaites : seules les transitions système (webhook, job) omettent ce
 * chargement, et aucune ne dépend de ces gardes.
 */
export function toContractSnapshot(c: any, extras: SnapshotExtras = {}): ContractSnapshot {
  const signers: { party: string }[] | undefined = c.signers;
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    startDate: c.startDate,
    endDate: c.endDate,
    noticePeriodDays: c.noticePeriodDays,
    currentVersionId: c.currentVersionId,
    approvedVersionId: c.approvedVersionId,
    submittedByUserId: extras.submittedByUserId ?? null,
    hasLsiSigner: signers ? signers.some((s) => s.party === 'LSI') : true,
    hasClientSigner: signers ? signers.some((s) => s.party === 'CLIENT') : true,
    // Simplification MVP : la notion de pièce jointe OBLIGATOIRE dépendra
    // du modèle (ticket C-02). Aucune n'est obligatoire aujourd'hui.
    hasRequiredAttachments: true,
    openAmendmentExists: (c.amendments ?? []).some((a: any) => !CLOSED_AMENDMENT.includes(a.status)),
    // Un lien `successorContractId` ne veut PAS dire « signé » : seul
    // l'appelant qui a lu le VRAI `signedAt` du successeur peut l'affirmer.
    hasSignedSuccessor: extras.hasSignedSuccessor ?? false,
    signedAt: c.signedAt,
    activatedAt: c.activatedAt,
    terminatedAt: c.terminatedAt,
    acceptedVersionId: c.acceptedVersionId ?? null,
    hasUnreviewedAiClauses: (c.unreviewedAiClauses ?? 0) > 0,
    terminationEffectiveDate: c.terminationEffectiveDate ?? null,
    hasMissingVariables: (c.missingVariables ?? 0) > 0,
  };
}

/** Événement métier et motif, tels qu'enregistrés dans lifecycle_events. */
export function transitionContext(event: ContractEvent): { event: string; reason: string | null } {
  const reason = 'reason' in event && typeof event.reason === 'string' ? event.reason.trim() || null : null;
  return { event: event.type, reason };
}

/**
 * Persiste l'état renvoyé par la machine. Pose d'abord le contexte de
 * transition (événement, motif) lu par le trigger `contracts_status_transition`.
 *
 * `userId` : acteur de la mise à jour (colonne updated_by), omis pour le système.
 */
export async function persistTransition(
  tx: any,
  contractId: string,
  event: ContractEvent,
  next: ContractSnapshot,
  now: Date,
  userId?: string,
) {
  await setTransitionContext(tx, transitionContext(event));
  return tx.contract.update({
    where: { id: contractId },
    data: {
      status: next.status,
      approvedVersionId: next.approvedVersionId,
      acceptedVersionId: next.acceptedVersionId ?? null,
      endDate: next.endDate,
      signedAt: next.signedAt ?? null,
      activatedAt: next.activatedAt ?? null,
      terminatedAt: next.terminatedAt ?? null,
      terminationEffectiveDate: next.terminationEffectiveDate ?? null,
      updatedAt: now,
      ...(userId ? { updatedByUserId: userId } : {}),
    },
  });
}
