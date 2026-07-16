/**
 * Types du domaine contractuel.
 *
 * Le domaine ne dépend NI de Prisma, NI de HTTP, NI de DocuSeal.
 * Les énumérations sont redéfinies ici plutôt qu'importées du client Prisma :
 * le schéma de base est un détail de persistance, pas la source de vérité
 * métier. Les valeurs sont identiques, donc la conversion est un cast à la
 * frontière — pas une traduction.
 *
 * Conséquence concrète : ce fichier est testable sans démarrer PostgreSQL.
 */

export const CONTRACT_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PENDING_SIGNATURE',
  'PARTIALLY_SIGNED',
  'SIGNED',
  'ACTIVE',
  'EXPIRED',
  'TERMINATED',
  'RENEWED',
  'CANCELLED',
  'DECLINED',
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * États terminaux : aucune transition n'en sort.
 *
 * EXPIRED n'en fait PAS partie — un renouvellement tardif rétroactif est un
 * cas réel et fréquent (§7.2 note 2).
 */
export const TERMINAL_STATUSES = ['TERMINATED', 'RENEWED', 'CANCELLED', 'DECLINED'] as const;

/** Statuts où le fond contractuel est éditable (RM-04). */
export const EDITABLE_STATUSES = ['DRAFT', 'CHANGES_REQUESTED'] as const;

export type ContractType = 'MAIN' | 'AMENDMENT';

/**
 * Vue du contrat nécessaire aux décisions de la machine à états.
 *
 * Volontairement un SNAPSHOT plat et non l'entité Prisma : la machine ne doit
 * pas pouvoir charger paresseusement une relation, donc pas pouvoir toucher la
 * base. Les booléens (`hasClientSigner`, `openAmendmentExists`) sont calculés
 * par la couche applicative et passés ici — c'est ce qui rend le domaine pur
 * et testable en mémoire.
 */
export interface ContractSnapshot {
  readonly id: string;
  readonly type: ContractType;
  readonly status: ContractStatus;

  readonly startDate: Date | null;
  /** null = durée indéterminée (EC-13). */
  readonly endDate: Date | null;
  readonly noticePeriodDays: number | null;

  readonly currentVersionId: string | null;
  /** RM-11 : la version sur laquelle porte la validation. */
  readonly approvedVersionId: string | null;
  /** RM-10 : qui a soumis, pour interdire l'auto-validation. */
  readonly submittedByUserId: string | null;

  readonly hasLsiSigner: boolean;
  readonly hasClientSigner: boolean;
  readonly hasRequiredAttachments: boolean;

  /** RM-19 : un seul avenant en cours par parent. */
  readonly openAmendmentExists: boolean;
  /** §7.2 : détermine EXPIRED vs RENEWED au terme. */
  readonly hasSignedSuccessor: boolean;

  readonly signedAt?: Date | null;
  readonly activatedAt?: Date | null;
  readonly terminatedAt?: Date | null;
}

export type ContractEvent =
  | { type: 'SUBMIT_FOR_REVIEW'; actorUserId: string }
  | { type: 'APPROVE'; actorUserId: string }
  | { type: 'REQUEST_CHANGES'; actorUserId: string; reason: string }
  | { type: 'EDIT_CONTENT'; actorUserId: string }
  | { type: 'SEND_FOR_SIGNATURE'; actorUserId: string }
  /** Émis par le SYSTEM sur webhook vérifié uniquement (RM-14). */
  | { type: 'SIGNER_SIGNED'; allSigned: boolean }
  | { type: 'SIGNER_DECLINED'; reason: string }
  | { type: 'ACTIVATE' }
  | { type: 'EXPIRE' }
  | { type: 'MARK_RENEWED'; successorContractId: string }
  | { type: 'CANCEL'; actorUserId: string; reason: string }
  | {
      type: 'TERMINATE';
      actorUserId: string;
      reason: string;
      effectiveDate: Date;
      isAdmin: boolean;
      overrideReason?: string;
    };

export type ContractEventType = ContractEvent['type'];
