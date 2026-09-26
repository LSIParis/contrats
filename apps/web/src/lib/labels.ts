/**
 * Libellés français des énumérations métier. (UI en français)
 *
 * Source unique pour l'affichage des statuts : les valeurs d'enum
 * (ACTIVE, PENDING_SIGNATURE…) ne doivent JAMAIS apparaître telles quelles à
 * l'écran. Chaque helper retombe sur la valeur brute si elle est inconnue —
 * on préfère afficher un code lisible plutôt que « undefined ».
 */

/**
 * Statuts du cycle de vie d'un contrat, dans l'ordre du cycle (brief §2).
 * Cet ordre sert aussi à l'affichage (légendes, badges de statut, charte graphique).
 */
export const CONTRACT_STATUS_CODES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SENT_TO_CLIENT',
  'IN_NEGOTIATION',
  'ACCEPTED',
  'PENDING_SIGNATURE',
  'PARTIALLY_SIGNED',
  'SIGNED',
  'ACTIVE',
  'RENEWAL_DUE',
  'RENEWED',
  'TERMINATION_PENDING',
  'TERMINATED',
  'EXPIRED',
  'CANCELLED',
  'DECLINED',
  'SIGNATURE_EXPIRED',
  'IMPORTED_PENDING_VALIDATION',
] as const;

export type ContractStatusCode = (typeof CONTRACT_STATUS_CODES)[number];

const CONTRACT_STATUS_FR: Record<ContractStatusCode, string> = {
  DRAFT: 'Brouillon',
  IN_REVIEW: 'En revue interne',
  CHANGES_REQUESTED: 'Modifications demandées',
  APPROVED: 'Validé',
  SENT_TO_CLIENT: 'Envoyé au client',
  IN_NEGOTIATION: 'En négociation',
  ACCEPTED: 'Accepté',
  PENDING_SIGNATURE: 'En signature',
  PARTIALLY_SIGNED: 'Partiellement signé',
  SIGNED: 'Signé',
  ACTIVE: 'Actif',
  RENEWAL_DUE: 'À renouveler',
  RENEWED: 'Renouvelé',
  TERMINATION_PENDING: 'En résiliation',
  TERMINATED: 'Résilié',
  EXPIRED: 'Expiré',
  CANCELLED: 'Annulé',
  DECLINED: 'Refusé',
  SIGNATURE_EXPIRED: 'Signature expirée',
  IMPORTED_PENDING_VALIDATION: 'Importé à valider',
};

/** Vrai si la valeur est un statut de contrat connu (garde de type). */
export const isContractStatus = (s: string): s is ContractStatusCode =>
  (CONTRACT_STATUS_CODES as readonly string[]).includes(s);

const SIGNER_STATUS_FR: Record<string, string> = {
  PENDING: 'En attente',
  SENT: 'Envoyé',
  VIEWED: 'Consulté',
  SIGNED: 'Signé',
  DECLINED: 'Refusé',
};

const REMINDER_STATUS_FR: Record<string, string> = {
  PENDING: 'En attente',
  SENT: 'Envoyé',
  SKIPPED_OBSOLETE: 'Ignoré (obsolète)',
  CANCELLED: 'Annulé',
  FAILED: 'Échec',
};

const PARTY_FR: Record<string, string> = {
  LSI: 'LSI',
  CLIENT: 'Client',
};

const CONTRACT_CATEGORY_FR: Record<string, string> = {
  MAINTENANCE: 'Maintenance',
  SUPPORT: 'Support',
  HOSTING: 'Hébergement',
  SLA: 'Niveau de service (SLA)',
  OTHER: 'Autre',
};

const BILLING_FREQUENCY_FR: Record<string, string> = {
  MONTHLY: 'Mensuelle',
  QUARTERLY: 'Trimestrielle',
  YEARLY: 'Annuelle',
  ONE_OFF: 'Ponctuelle',
};

const ROLE_FR: Record<string, string> = {
  MSP_ADMIN: 'Administrateur',
  ACCOUNT_MANAGER: 'Chargé de compte',
  LEGAL_REVIEWER: 'Relecteur juridique',
  TECHNICIAN: 'Technicien',
  CLIENT_SIGNER: 'Signataire client',
  CLIENT_VIEWER: 'Lecteur client',
};

const USER_KIND_FR: Record<string, string> = {
  INTERNAL: 'Interne',
  CLIENT: 'Client',
};

const ACTOR_KIND_FR: Record<string, string> = {
  INTERNAL: 'Interne',
  CLIENT: 'Client',
  SYSTEM: 'Système',
};

export const contractStatusLabel = (s: string): string => (isContractStatus(s) ? CONTRACT_STATUS_FR[s] : s);
export const signerStatusLabel = (s: string): string => SIGNER_STATUS_FR[s] ?? s;
export const reminderStatusLabel = (s: string): string => REMINDER_STATUS_FR[s] ?? s;
export const partyLabel = (s: string): string => PARTY_FR[s] ?? s;
export const contractCategoryLabel = (s: string): string => CONTRACT_CATEGORY_FR[s] ?? s;

const TEMPLATE_STATUS_FR: Record<string, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publié',
  DEPRECATED: 'Déprécié',
};
export const templateStatusLabel = (s: string): string => TEMPLATE_STATUS_FR[s] ?? s;
export const billingFrequencyLabel = (s: string): string => BILLING_FREQUENCY_FR[s] ?? s;
export const roleLabel = (s: string): string => ROLE_FR[s] ?? s;
export const userKindLabel = (s: string): string => USER_KIND_FR[s] ?? s;
export const actorKindLabel = (s: string): string => ACTOR_KIND_FR[s] ?? s;

export function commentAuthorLabel(kind: string): string {
  return kind === 'CLIENT' ? 'Vous' : 'LSI';
}

export function commentVisibilityLabel(visibility: string): string {
  return visibility === 'SHARED' ? 'Partagé client' : 'Interne';
}

export function notificationTypeLabel(type: string): string {
  if (type === 'CLIENT_COMMENT') return 'Message client';
  if (type.startsWith('REMINDER')) return 'Rappel';
  return type;
}
