import { Icon, type IconName } from '../../ui/icons.js';
import { STATUS_TONES, type StatusTone } from '../../ui/theme/status.js';
import type { ProposalStatus } from './proposal-api.js';

/**
 * Libellés français du module Propositions (codes anglais en base, français à
 * l'écran — 11-propositions.md §3). Même règle que les contrats : une couleur,
 * une icône ET un mot par statut ; la couleur ne porte jamais seule le sens.
 */

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
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

const STATUS_STYLE: Record<ProposalStatus, { tone: StatusTone; icon: IconName }> = {
  DRAFT: { tone: 'neutral', icon: 'pencil' },
  IN_INTERNAL_REVIEW: { tone: 'info', icon: 'clipboard' },
  READY: { tone: 'success', icon: 'check' },
  SENT: { tone: 'info', icon: 'send' },
  VIEWED: { tone: 'info', icon: 'eye' },
  IN_DISCUSSION: { tone: 'warn', icon: 'message' },
  ACCEPTED: { tone: 'success', icon: 'checkCircle' },
  PENDING_SIGNATURE: { tone: 'warn', icon: 'pen' },
  SIGNED: { tone: 'success', icon: 'fileCheck' },
  CONVERTED: { tone: 'success', icon: 'contract' },
  EXPIRED: { tone: 'danger', icon: 'calendarX' },
  DECLINED: { tone: 'danger', icon: 'xCircle' },
  WITHDRAWN: { tone: 'muted', icon: 'ban' },
};

export const proposalStatusLabel = (s: string): string => PROPOSAL_STATUS_LABELS[s as ProposalStatus] ?? s;

export function ProposalStatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status as ProposalStatus];
  const tone = STATUS_TONES[style?.tone ?? 'neutral'];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[9px] py-0.5 align-middle text-xs font-semibold leading-[1.6] ${tone.className}`}
    >
      {style && <Icon name={style.icon} className="h-3.5 w-3.5" strokeWidth={2} />}
      {proposalStatusLabel(status)}
    </span>
  );
}

export const ACCEPTANCE_MODE_LABELS: Record<string, string> = {
  DOCUSEAL_SIGNATURE: 'Signature électronique (DocuSeal)',
  CLICK_ACCEPT: 'Acceptation par clic (code e-mail)',
};

export const RECIPIENT_ROLE_LABELS: Record<string, string> = {
  DECISION_MAKER: 'Décideur',
  SIGNER: 'Signataire',
  READER: 'Lecteur',
};

export const SECTION_KIND_LABELS: Record<string, string> = {
  COVER: 'Couverture',
  LIBRARY: 'Bibliothèque',
  TEXT: 'Texte libre',
  CLIENT_INPUT: 'Contexte client',
  PRICING: 'Tableau de prix',
  TERMS: 'CGV',
  SIGNATURE: 'Signature',
};

export const BLOCK_TYPE_LABELS: Record<string, string> = {
  RICH_TEXT: 'Texte',
  IMAGE: 'Image',
  VIDEO: 'Vidéo hébergée',
  PRICING_TABLE: 'Tableau de prix',
  TIMELINE: 'Planning',
  TEAM: 'Équipe',
  REFERENCES: 'Références',
  FAQ: 'Questions fréquentes',
  TERMS: 'CGV',
  SIGNATURE: 'Zone de signature',
};

export const VIEW_EVENT_LABELS: Record<string, string> = {
  OPENED: 'Ouverture',
  SECTION_VIEWED: 'Lecture de section',
  PDF_DOWNLOADED: 'Téléchargement du PDF',
  NEW_VIEWER: 'Nouveau lecteur (lien transféré ?)',
};

export const DELIVERY_KIND_LABELS: Record<string, string> = {
  INITIAL: 'Envoi initial',
  RESEND: 'Renvoi',
  NEW_VERSION: 'Nouvelle version',
  FOLLOW_UP: 'Relance',
  OTP: 'Code à usage unique',
  REVISION_NOTICE: 'Avis de révision',
};

export const FOLLOW_UP_KIND_LABELS: Record<string, string> = {
  NO_OPEN: 'Sans ouverture',
  NO_DECISION: 'Sans décision',
  BEFORE_EXPIRY: 'Avant échéance',
};

export const FOLLOW_UP_STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Planifiée',
  SENT: 'Envoyée',
  SKIPPED: 'Sautée',
  CANCELLED: 'Annulée',
};

export const SIGNATURE_STATUS_LABELS: Record<string, string> = {
  CREATING: 'En préparation',
  SENT: 'Envoyée en signature',
  PARTIALLY_COMPLETED: 'Partiellement signée',
  COMPLETED: 'Signée',
  DECLINED: 'Refusée par un signataire',
  EXPIRED: 'Expirée',
  REVOKED: 'Révoquée',
  FAILED: 'En échec',
};

export const PRICE_SCOPE_LABELS: Record<string, string> = { LINE: 'Ligne de prix', RULE: 'Règle', SECTION: 'Section', CHOICE: 'Choix' };

export const RECURRENCE_LABELS: Record<string, string> = {
  ONE_TIME: 'Ponctuel',
  MONTHLY: 'Mensuel',
  QUARTERLY: 'Trimestriel',
  YEARLY: 'Annuel',
  INFO: 'Hors forfait',
  DISCOUNT: 'Remise',
  MINIMUM: 'Minimum mensuel',
};

export const DECLINE_REASON_LABELS: Record<string, string> = {
  PRICE: 'Prix',
  COMPETITOR: 'Concurrent retenu',
  TIMING: 'Calendrier',
  SCOPE: 'Périmètre',
  NO_PROJECT: 'Projet abandonné',
  OTHER: 'Autre',
};

export const COMMERCIAL_STATUS_LABELS: Record<string, string> = { PROSPECT: 'Prospect', CLIENT: 'Client', FORMER_CLIENT: 'Ancien client' };

export const label = (map: Record<string, string>, v: string | null | undefined): string => (v ? (map[v] ?? v) : '—');

/** Balises de fusion du catalogue (miroir de `packages/domain/src/proposal/merge-tags.ts`). */
export const MERGE_TAGS: { tag: string; label: string; input: boolean }[] = [
  { tag: 'client.raisonSociale', label: 'Raison sociale du client', input: false },
  { tag: 'client.siren', label: 'SIREN du client', input: false },
  { tag: 'client.effectif', label: 'Effectif du client', input: true },
  { tag: 'contact.civilite', label: 'Civilité du contact', input: true },
  { tag: 'contact.nom', label: 'Nom du contact', input: false },
  { tag: 'contact.prenom', label: 'Prénom du contact', input: false },
  { tag: 'commercial.nom', label: 'Nom du commercial', input: false },
  { tag: 'proposition.numero', label: 'Numéro de la proposition', input: false },
  { tag: 'proposition.dateExpiration', label: 'Date d’expiration', input: false },
  { tag: 'parc.nbPostes', label: 'Nombre de postes', input: true },
  { tag: 'parc.nbServeurs', label: 'Nombre de serveurs', input: true },
  { tag: 'parc.nbEquipementsReseau', label: 'Nombre d’équipements réseau', input: true },
  { tag: 'parc.nbUtilisateursM365', label: 'Nombre d’utilisateurs Microsoft 365', input: true },
  { tag: 'tarif.totalPonctuelHT', label: 'Total ponctuel HT', input: false },
  { tag: 'tarif.totalMensuelHT', label: 'Total mensuel récurrent HT', input: false },
  { tag: 'tarif.totalEngagementHT', label: 'Total sur la durée d’engagement HT', input: false },
  { tag: 'engagement.dureeMois', label: 'Durée d’engagement (mois)', input: false },
];

export function findMergeTags(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1] as string))];
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

export function formatDuration(ms: string | number | null | undefined): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 s';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}
