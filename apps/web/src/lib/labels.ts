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

export const contractStatusLabel = (s: string): string => CONTRACT_STATUS_FR[s] ?? s;
export const signerStatusLabel = (s: string): string => SIGNER_STATUS_FR[s] ?? s;
export const reminderStatusLabel = (s: string): string => REMINDER_STATUS_FR[s] ?? s;
export const partyLabel = (s: string): string => PARTY_FR[s] ?? s;
export const contractCategoryLabel = (s: string): string => CONTRACT_CATEGORY_FR[s] ?? s;
export const billingFrequencyLabel = (s: string): string => BILLING_FREQUENCY_FR[s] ?? s;
