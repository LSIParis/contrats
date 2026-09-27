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
  INTERNAL_SIGNATORY: 'Signataire interne',
  READER: 'Lecteur',
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

/** Natures d'échéance (02-cycle-de-vie.md §6). */
const DEADLINE_KIND_FR: Record<string, string> = {
  PERIOD_END: 'Fin de période',
  NOTICE_DEADLINE: 'Date limite de dénonciation',
  RENEWAL_DECISION: 'Décision de renouvellement',
  CHATEL_NOTICE: 'Information loi Chatel',
  PRICE_REVISION: 'Révision tarifaire',
  TERMINATION_EFFECTIVE: 'Prise d’effet de la résiliation',
};
export const deadlineKindLabel = (s: string): string => DEADLINE_KIND_FR[s] ?? s;

/** États de l'OCR d'un contrat importé (03-import-existant.md). */
const OCR_STATUS_FR: Record<string, string> = {
  PENDING: 'En attente',
  RUNNING: 'En cours',
  DONE: 'Terminé',
  FAILED: 'Échec',
  SKIPPED: 'Non nécessaire',
};
export const ocrStatusLabel = (s: string): string => OCR_STATUS_FR[s] ?? s;

const RENEWAL_MODE_FR: Record<string, string> = {
  NONE: 'Aucune (terme ferme)',
  TACIT: 'Tacite reconduction',
  EXPRESS: 'Reconduction expresse',
};
export const renewalModeLabel = (s: string): string => RENEWAL_MODE_FR[s] ?? s;

export function notificationTypeLabel(type: string): string {
  if (type === 'CLIENT_COMMENT') return 'Message client';
  if (type.startsWith('REMINDER')) return 'Rappel';
  return type;
}

// ---------------------------------------------------------------------------
// v2 — contenu structuré, IA, négociation, signature, cycle de vie (lots 2, 4, 5, 6)
// ---------------------------------------------------------------------------

/** Catégories de clauses (01-domaine.md §6). */
export const CLAUSE_CATEGORY_CODES = [
  'OBJET', 'DUREE', 'PRIX', 'SLA', 'RESPONSABILITE', 'RGPD', 'CONFIDENTIALITE',
  'PROPRIETE_INTELLECTUELLE', 'ASSURANCE', 'RESILIATION', 'DIVERS',
] as const;
const CLAUSE_CATEGORY_FR: Record<string, string> = {
  OBJET: 'Objet',
  DUREE: 'Durée',
  PRIX: 'Prix',
  SLA: 'Niveaux de service',
  RESPONSABILITE: 'Responsabilité',
  RGPD: 'Données personnelles (RGPD)',
  CONFIDENTIALITE: 'Confidentialité',
  PROPRIETE_INTELLECTUELLE: 'Propriété intellectuelle',
  ASSURANCE: 'Assurance',
  RESILIATION: 'Résiliation',
  DIVERS: 'Divers',
  // Catégories fines du fournisseur IA (détection des clauses manquantes)
  DEFINITIONS: 'Définitions',
  PAIEMENT: 'Paiement',
  REVISION: 'Révision de prix',
  NIVEAUX_DE_SERVICE: 'Niveaux de service',
  OBLIGATIONS_PRESTATAIRE: 'Obligations du prestataire',
  OBLIGATIONS_CLIENT: 'Obligations du client',
  DONNEES_PERSONNELLES: 'Données personnelles',
  SECURITE: 'Sécurité',
  SOUS_TRAITANCE: 'Sous-traitance',
  REVERSIBILITE: 'Réversibilité',
  FORCE_MAJEURE: 'Force majeure',
  LITIGES: 'Litiges',
  AUTRE: 'Autre',
};
export const clauseCategoryLabel = (s: string): string => CLAUSE_CATEGORY_FR[s] ?? s;

const CLAUSE_ORIGIN_FR: Record<string, string> = {
  TEMPLATE: 'Contrat type',
  LIBRARY: 'Bibliothèque',
  CUSTOM: 'Rédaction libre',
  AI: 'Générée par IA',
};
export const clauseOriginLabel = (s: string): string => CLAUSE_ORIGIN_FR[s] ?? s;

export const ANNEX_KIND_CODES = ['SLA', 'ASSETS', 'PRICING_GRID', 'DPA_ART28', 'OTHER'] as const;
const ANNEX_KIND_FR: Record<string, string> = {
  SLA: 'Niveaux de service (SLA)',
  ASSETS: 'Liste des équipements',
  PRICING_GRID: 'Grille tarifaire',
  DPA_ART28: 'Sous-traitance de données (RGPD art. 28)',
  OTHER: 'Autre annexe',
};
export const annexKindLabel = (s: string): string => ANNEX_KIND_FR[s] ?? s;

const RISK_FR: Record<string, string> = { LOW: 'Risque faible', MEDIUM: 'Risque moyen', HIGH: 'Risque élevé' };
export const riskLevelLabel = (s: string): string => RISK_FR[s] ?? s;

const REVIEW_DECISION_FR: Record<string, string> = { APPROVED: 'Validée', REJECTED: 'Rejetée' };
export const reviewDecisionLabel = (s: string): string => REVIEW_DECISION_FR[s] ?? s;

const ACCEPTANCE_METHOD_FR: Record<string, string> = {
  PORTAL: 'Depuis l’espace client',
  RECORDED_BY_STAFF: 'Enregistrée par LSI',
};
export const acceptanceMethodLabel = (s: string): string => ACCEPTANCE_METHOD_FR[s] ?? s;

export const SIGNING_ORDER_CODES = ['CLIENT_THEN_LSI', 'LSI_THEN_CLIENT', 'PARALLEL', 'AS_DEFINED'] as const;
const SIGNING_ORDER_FR: Record<string, string> = {
  CLIENT_THEN_LSI: 'Le client, puis LSI-Maintenance',
  LSI_THEN_CLIENT: 'LSI-Maintenance, puis le client',
  PARALLEL: 'En parallèle',
  AS_DEFINED: 'Selon l’ordre du bloc Signataires',
};
export const signingOrderLabel = (s: string): string => SIGNING_ORDER_FR[s] ?? s;

/** Événements du journal des transitions (lifecycle_events). */
const LIFECYCLE_EVENT_FR: Record<string, string> = {
  CREATE: 'Création',
  SUBMIT_FOR_REVIEW: 'Soumis en revue interne',
  APPROVE: 'Validé en revue interne',
  REQUEST_CHANGES: 'Modifications demandées',
  EDIT_CONTENT: 'Contenu modifié',
  SEND_TO_CLIENT: 'Envoyé au client',
  OPEN_NEGOTIATION: 'Négociation ouverte',
  REOPEN_NEGOTIATION: 'Négociation rouverte',
  CLIENT_ACCEPT: 'Accepté par le client',
  SEND_FOR_SIGNATURE: 'Envoyé en signature',
  SIGNER_SIGNED: 'Signature d’un signataire',
  SIGNER_DECLINED: 'Signature refusée',
  SIGNATURE_EXPIRE: 'Signature expirée',
  REVOKE_SIGNATURE: 'Signature révoquée',
  ACTIVATE: 'Activé',
  OPEN_RENEWAL: 'Renouvellement à décider',
  RENEW_PERIOD: 'Renouvelé pour une nouvelle période',
  CLOSE_RENEWAL: 'Non renouvelé',
  MARK_RENEWED: 'Remplacé par un nouveau contrat',
  TERMINATE: 'Résiliation enregistrée',
  WITHDRAW_TERMINATION: 'Résiliation retirée',
  COMPLETE_TERMINATION: 'Résiliation effective',
  EXPIRE: 'Expiré',
  CANCEL: 'Annulé',
  VALIDATE_IMPORT: 'Import validé',
};
export const lifecycleEventLabel = (s: string): string => LIFECYCLE_EVENT_FR[s] ?? s;

const REMINDER_KIND_FR: Record<string, string> = {
  EXPIRY: 'Échéance du contrat',
  NOTICE_DEADLINE: 'Date limite de dénonciation',
  PRICE_REVISION: 'Révision tarifaire',
  RENEWAL_DECISION: 'Décision de renouvellement',
  CHATEL_NOTICE: 'Information loi Chatel',
  TERMINATION_EFFECTIVE: 'Prise d’effet de la résiliation',
};
export const reminderKindLabel = (s: string): string => REMINDER_KIND_FR[s] ?? s;
