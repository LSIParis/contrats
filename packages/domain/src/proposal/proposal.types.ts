/**
 * Types du domaine « propositions commerciales » (brief §12,
 * docs/contrats/11-propositions.md).
 *
 * Même principe que le contrat : énumérations redéfinies ici (le schéma de
 * base est un détail de persistance), snapshot PLAT calculé par la couche
 * applicative, machine pure et testable sans base.
 *
 * Codes anglais en base, libellés français à l'écran :
 *   BROUILLON → DRAFT · EN_REVUE_INTERNE → IN_INTERNAL_REVIEW · PRÊTE → READY
 *   ENVOYÉE → SENT · CONSULTÉE → VIEWED · EN_DISCUSSION → IN_DISCUSSION
 *   ACCEPTÉE → ACCEPTED · EN_SIGNATURE → PENDING_SIGNATURE · SIGNÉE → SIGNED
 *   CONVERTIE → CONVERTED · EXPIRÉE → EXPIRED · REFUSÉE → DECLINED
 *   RETIRÉE → WITHDRAWN.
 * REMPLACÉE n'est pas un état de la proposition mais de sa VERSION
 * (`proposal_versions.superseded_at`) : c'est la version qu'une nouvelle
 * version remplace, la proposition, elle, continue.
 */

export const PROPOSAL_STATUSES = [
  'DRAFT',
  'IN_INTERNAL_REVIEW',
  'READY',
  'SENT',
  'VIEWED',
  'IN_DISCUSSION',
  'ACCEPTED',
  'PENDING_SIGNATURE',
  'SIGNED',
  'CONVERTED',
  'EXPIRED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TERMINAL_STATUSES = ['CONVERTED', 'DECLINED', 'WITHDRAWN'] as const;

/** Libellés français (interface, e-mails, documentation). */
export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  DRAFT: 'Brouillon',
  IN_INTERNAL_REVIEW: 'En revue interne',
  READY: 'Prête',
  SENT: 'Envoyée',
  VIEWED: 'Consultée',
  IN_DISCUSSION: 'En discussion',
  ACCEPTED: 'Acceptée',
  PENDING_SIGNATURE: 'En signature',
  SIGNED: 'Signée',
  CONVERTED: 'Convertie',
  EXPIRED: 'Expirée',
  DECLINED: 'Refusée',
  WITHDRAWN: 'Retirée',
};

export type AcceptanceMode = 'DOCUSEAL_SIGNATURE' | 'CLICK_ACCEPT';

/**
 * Vue de la proposition nécessaire aux décisions de la machine.
 *
 * Les compteurs de préparation (`unresolvedMergeTags`, `blockingValidations`,
 * `pricingErrors`) sont calculés par la couche applicative sur la version
 * COURANTE : balises non résolues, éléments « à valider » retenus (même
 * logique que `blockingValidations` de l'annexe C), erreurs du moteur de
 * tarification. La machine ne fait que trancher.
 */
export interface ProposalSnapshot {
  readonly id: string;
  readonly status: ProposalStatus;
  readonly currentVersionId: string | null;
  readonly acceptanceMode: AcceptanceMode;
  /** Échéance de validité (null tant que la proposition n'est pas envoyée). */
  readonly expiresAt: Date | null;
  /** Revue interne obligatoire (remise, clause dérogatoire, montant — seuils du tenant). */
  readonly reviewRequired: boolean;
  readonly reviewSubmittedByUserId: string | null;
  /** Version validée en revue interne (null = aucune validation en cours). */
  readonly reviewApprovedVersionId: string | null;
  readonly acceptedVersionId: string | null;
  readonly hasRecipients: boolean;
  /** Au moins un destinataire signataire (ou décideur pour l'acceptation par clic). */
  readonly hasSigner: boolean;
  readonly unresolvedMergeTags: number;
  readonly blockingValidations: number;
  readonly pricingErrors: number;
}

/** Motifs de refus (liste fermée + texte libre, exploités dans les rapports). */
export const DECLINE_REASON_CODES = ['PRICE', 'COMPETITOR', 'TIMING', 'SCOPE', 'NO_PROJECT', 'OTHER'] as const;
export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number];

export type ProposalEvent =
  | { readonly type: 'SUBMIT_FOR_REVIEW'; readonly actorUserId: string }
  | { readonly type: 'APPROVE_REVIEW'; readonly actorUserId: string }
  | { readonly type: 'REJECT_REVIEW'; readonly actorUserId: string; readonly reason: string }
  | { readonly type: 'MARK_READY'; readonly actorUserId: string }
  | { readonly type: 'SEND'; readonly expiresAt: Date }
  | { readonly type: 'VIEW' }
  | { readonly type: 'OPEN_DISCUSSION' }
  | { readonly type: 'CLOSE_DISCUSSION' }
  | { readonly type: 'ACCEPT'; readonly versionId: string }
  | { readonly type: 'START_SIGNATURE' }
  | { readonly type: 'COMPLETE_CLICK_ACCEPT' }
  | { readonly type: 'SIGNATURE_COMPLETED' }
  | { readonly type: 'SIGNATURE_DECLINED'; readonly reason: string }
  | { readonly type: 'SIGNATURE_EXPIRED' }
  | { readonly type: 'CONVERT'; readonly contractId: string }
  | { readonly type: 'EXPIRE' }
  | { readonly type: 'DECLINE'; readonly reasonCode: string; readonly reason: string }
  | { readonly type: 'WITHDRAW'; readonly reason: string }
  | { readonly type: 'REACTIVATE'; readonly expiresAt: Date; readonly reason: string }
  | { readonly type: 'REVISE'; readonly reason: string };

export type ProposalEventType = ProposalEvent['type'];

export const PROPOSAL_EVENT_TYPES: readonly ProposalEventType[] = [
  'SUBMIT_FOR_REVIEW', 'APPROVE_REVIEW', 'REJECT_REVIEW', 'MARK_READY', 'SEND', 'VIEW',
  'OPEN_DISCUSSION', 'CLOSE_DISCUSSION', 'ACCEPT', 'START_SIGNATURE', 'COMPLETE_CLICK_ACCEPT',
  'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED', 'CONVERT', 'EXPIRE', 'DECLINE',
  'WITHDRAW', 'REACTIVATE', 'REVISE',
];
