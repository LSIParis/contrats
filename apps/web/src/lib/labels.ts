/**
 * Libellés français des énumérations métier. (UI en français)
 *
 * Source unique pour l'affichage des statuts : les valeurs d'enum
 * (ACTIVE, PENDING_SIGNATURE…) ne doivent JAMAIS apparaître telles quelles à
 * l'écran. Chaque helper retombe sur la valeur brute si elle est inconnue —
 * on préfère afficher un code lisible plutôt que « undefined ».
 */

const CONTRACT_STATUS_FR: Record<string, string> = {
  DRAFT: 'Brouillon',
  IN_REVIEW: 'En relecture',
  CHANGES_REQUESTED: 'Modifications demandées',
  APPROVED: 'Approuvé',
  PENDING_SIGNATURE: 'En attente de signature',
  PARTIALLY_SIGNED: 'Partiellement signé',
  SIGNED: 'Signé',
  ACTIVE: 'Actif',
  EXPIRED: 'Expiré',
  TERMINATED: 'Résilié',
  RENEWED: 'Renouvelé',
  CANCELLED: 'Annulé',
  DECLINED: 'Refusé',
};

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

export const contractStatusLabel = (s: string): string => CONTRACT_STATUS_FR[s] ?? s;
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
