/**
 * Correspondance « proposition d'extraction » → « champs du contrat » pour l'écran de
 * validation côte à côte (03-import-existant.md §5, brief §3 étape 5).
 *
 * Fonctions PURES : la proposition n'est qu'un pré-remplissage, le valideur corrige
 * chaque champ avant l'envoi de `POST /v1/contracts/:id/import/validate`
 * (ValidateImportSchema côté API).
 */
import { centsToEurosInput, eurosToCents } from '../../lib/money.js';

export interface Evidence { excerpt: string; offset: number }

/** Un champ proposé : par règles (OCR) ou saisi au dépôt (confiance 1, sans preuve). */
export interface ProposedField<T = unknown> {
  value: T;
  confidence: number;
  evidence: Evidence | null;
  method?: string;
}

export type Extraction = Record<string, ProposedField | null | undefined>;

export type OcrStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** Réponse de `GET /v1/contracts/:id/import` (ImportsService.get). */
export interface ImportView {
  contract: {
    id: string; reference: string; title: string; status: string; category: string; customerId: string;
    startDate: string | null; endDate: string | null; signedAt: string | null;
    noticePeriodDays: number | null; noticePeriodMonths: number | null;
    renewalMode: string | null; renewalPeriodMonths: number | null;
    amountCents: number | string | null; billingFrequency: string | null;
  };
  origin: 'LEGACY_IMPORT';
  signatureMode: 'EXTERNAL_WET_SIGNATURE';
  original: {
    id: string; filename: string; contentType: string; sizeBytes: number | string;
    sha256: string; createdAt: string; uploadedByUserId: string | null;
  };
  ocr: {
    status: OcrStatus; attempts: number; pages: number | null; error: string | null;
    searchablePdf: { id: string; sizeBytes: number | string; sha256: string } | null;
  };
  extraction: Extraction | null;
  extractionMethod: string | null;
  validated: { at: string; byUserId: string | null; fields: unknown } | null;
}

export type NoticeUnit = 'JOURS' | 'MOIS';

/** État du formulaire : tout en chaînes (valeurs de champs HTML). */
export interface ValidationForm {
  title: string;
  category: string;
  signedAt: string;
  startDate: string;
  endDate: string;
  noticeQuantity: string;
  noticeUnit: NoticeUnit;
  renewalMode: 'NONE' | 'TACIT' | 'EXPRESS';
  renewalPeriodMonths: string;
  amount: string;
  billingFrequency: string;
  chatelNotice: '' | 'true' | 'false';
  note: string;
}

export type FormKey = keyof ValidationForm;

/** D'où vient la valeur pré-remplie d'un champ (affichage de la confiance et de la preuve). */
export interface FieldSource {
  field: ProposedField | null;
  /** Explication d'une valeur DÉDUITE (ex. terme calculé depuis la durée). */
  derived?: string;
}

/** Corps de `POST /v1/contracts/:id/import/validate` (ValidateImportSchema). */
export interface ValidatePayload {
  title?: string;
  category?: string;
  signedAt?: string;
  startDate: string;
  endDate?: string;
  noticePeriodDays?: number;
  noticePeriodMonths?: number;
  renewalMode: 'NONE' | 'TACIT' | 'EXPRESS';
  renewalPeriodMonths?: number;
  amountCents?: number;
  billingFrequency?: string;
  chatelNotice?: boolean;
  note?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Date ISO `YYYY-MM-DD` d'une valeur API (date seule ou horodatage). */
export function isoDay(v: string | null | undefined): string {
  if (!v) return '';
  const d = v.slice(0, 10);
  return ISO_DATE.test(d) ? d : '';
}

/**
 * Terme d'un contrat de `months` mois prenant effet le `startIso` :
 * date d'effet + N mois − 1 jour (01/01/2024 + 12 mois → 31/12/2024).
 * Le jour est ramené au dernier jour du mois quand il n'existe pas (31 → 30/28/29).
 */
export function endDateFromDuration(startIso: string, months: number): string {
  if (!ISO_DATE.test(startIso) || !Number.isInteger(months) || months <= 0) return '';
  const [y, m, d] = startIso.split('-').map(Number) as [number, number, number];
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = targetMonth % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const anniversary = Date.UTC(ty, tm, Math.min(d, lastDay));
  return new Date(anniversary - 86_400_000).toISOString().slice(0, 10);
}

function pick(ex: Extraction | null, key: string): ProposedField | null {
  const f = ex?.[key];
  return f && typeof f === 'object' && 'value' in f ? f : null;
}

const RENEWAL: Record<string, ValidationForm['renewalMode']> = { TACITE: 'TACIT', EXPRESSE: 'EXPRESS', AUCUNE: 'NONE' };

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Pré-remplissage : la proposition d'extraction d'abord, les valeurs déjà portées par
 * le contrat ensuite (import déjà validé, ou colonnes renseignées autrement).
 */
export function prefill(view: ImportView): { form: ValidationForm; sources: Partial<Record<FormKey, FieldSource>> } {
  const ex = view.extraction;
  const c = view.contract;
  const sources: Partial<Record<FormKey, FieldSource>> = {};

  // Dates
  const effet = pick(ex, 'dateEffet');
  const startDate = typeof effet?.value === 'string' ? isoDay(effet.value) : isoDay(c.startDate);
  sources.startDate = { field: effet };

  const signature = pick(ex, 'dateSignature');
  const signedAt = typeof signature?.value === 'string' ? isoDay(signature.value) : isoDay(c.signedAt);
  sources.signedAt = { field: signature };

  const fin = pick(ex, 'dateFin');
  const duree = pick(ex, 'dureeMois');
  const months = toNumber(duree?.value);
  let endDate = isoDay(c.endDate);
  if (typeof fin?.value === 'string' && isoDay(fin.value)) {
    endDate = isoDay(fin.value);
    sources.endDate = { field: fin };
  } else if (months && startDate) {
    endDate = endDateFromDuration(startDate, months);
    sources.endDate = {
      field: duree,
      derived: `Calculé : date d’effet + ${months} mois − 1 jour.`,
    };
  } else {
    sources.endDate = { field: duree };
  }

  // Préavis
  const preavis = pick(ex, 'preavis');
  let noticeQuantity = '';
  let noticeUnit: NoticeUnit = 'JOURS';
  const pv = preavis?.value as { quantite?: unknown; unite?: unknown } | undefined;
  if (pv && toNumber(pv.quantite) != null) {
    noticeQuantity = String(toNumber(pv.quantite));
    noticeUnit = pv.unite === 'MOIS' ? 'MOIS' : 'JOURS';
  } else if (c.noticePeriodMonths != null) {
    noticeQuantity = String(c.noticePeriodMonths);
    noticeUnit = 'MOIS';
  } else if (c.noticePeriodDays != null) {
    noticeQuantity = String(c.noticePeriodDays);
  }
  sources.noticeQuantity = { field: preavis };

  // Reconduction
  const reconduction = pick(ex, 'reconduction');
  const renewalMode: ValidationForm['renewalMode'] =
    (typeof reconduction?.value === 'string' && RENEWAL[reconduction.value]) ||
    (c.renewalMode === 'TACIT' || c.renewalMode === 'EXPRESS' ? c.renewalMode : 'NONE');
  sources.renewalMode = { field: reconduction };
  let renewalPeriodMonths = c.renewalPeriodMonths != null ? String(c.renewalPeriodMonths) : '';
  if (!renewalPeriodMonths && renewalMode !== 'NONE' && months) {
    renewalPeriodMonths = String(months);
    sources.renewalPeriodMonths = { field: duree, derived: 'Proposé : même durée que la période initiale.' };
  }

  // Montant : saisi au dépôt, sinon mensuel HT, sinon annuel HT.
  const saisi = pick(ex, 'montantCentimes');
  const mensuel = pick(ex, 'montantMensuelHtCentimes');
  const annuel = pick(ex, 'montantAnnuelHtCentimes');
  let amount = '';
  let billingFrequency = c.billingFrequency ?? 'MONTHLY';
  let amountField: ProposedField | null = null;
  if (saisi && toNumber(saisi.value) != null) {
    amount = centsToEurosInput(toNumber(saisi.value)!);
    amountField = saisi;
  } else if (mensuel && toNumber(mensuel.value) != null) {
    amount = centsToEurosInput(toNumber(mensuel.value)!);
    billingFrequency = 'MONTHLY';
    amountField = mensuel;
  } else if (annuel && toNumber(annuel.value) != null) {
    amount = centsToEurosInput(toNumber(annuel.value)!);
    billingFrequency = 'YEARLY';
    amountField = annuel;
  } else if (toNumber(c.amountCents) != null) {
    amount = centsToEurosInput(toNumber(c.amountCents)!);
  }
  sources.amount = { field: amountField };

  return {
    form: {
      title: c.title ?? '',
      category: c.category ?? 'MAINTENANCE',
      signedAt,
      startDate,
      endDate,
      noticeQuantity,
      noticeUnit,
      renewalMode,
      renewalPeriodMonths,
      amount,
      billingFrequency,
      chatelNotice: '',
      note: '',
    },
    sources,
  };
}

export type FormErrors = Partial<Record<FormKey, string>>;

/** Contrôles locaux (les mêmes que l'API, pour un retour immédiat), puis corps de requête. */
export function toPayload(form: ValidationForm): { payload?: ValidatePayload; errors: FormErrors } {
  const errors: FormErrors = {};
  if (!ISO_DATE.test(form.startDate)) errors.startDate = 'La date d’effet est obligatoire.';
  if (form.endDate && form.startDate && form.endDate < form.startDate) {
    errors.endDate = 'Le terme ne peut pas précéder la date d’effet.';
  }
  const notice = form.noticeQuantity.trim();
  if (notice && !/^\d+$/.test(notice)) errors.noticeQuantity = 'Préavis : nombre entier attendu.';
  const period = form.renewalPeriodMonths.trim();
  if (form.renewalMode !== 'NONE') {
    if (!period) errors.renewalPeriodMonths = 'Une reconduction exige sa durée en mois.';
    else if (!/^\d+$/.test(period) || Number(period) < 1) errors.renewalPeriodMonths = 'Durée : nombre de mois entier ≥ 1.';
  }
  const cents = form.amount.trim() ? eurosToCents(form.amount) : undefined;
  if (form.amount.trim() && cents === undefined) errors.amount = 'Montant invalide (ex. 1500,00).';
  if (Object.keys(errors).length) return { errors };

  const payload: ValidatePayload = { startDate: form.startDate, renewalMode: form.renewalMode };
  if (form.title.trim()) payload.title = form.title.trim();
  if (form.category) payload.category = form.category;
  if (form.signedAt) payload.signedAt = form.signedAt;
  if (form.endDate) payload.endDate = form.endDate;
  if (notice) {
    if (form.noticeUnit === 'MOIS') payload.noticePeriodMonths = Number(notice);
    else payload.noticePeriodDays = Number(notice);
  }
  if (form.renewalMode !== 'NONE') payload.renewalPeriodMonths = Number(period);
  if (cents !== undefined) {
    payload.amountCents = cents;
    payload.billingFrequency = form.billingFrequency;
  }
  if (form.chatelNotice) payload.chatelNotice = form.chatelNotice === 'true';
  if (form.note.trim()) payload.note = form.note.trim();
  return { payload, errors };
}

/** Niveau de confiance : couleur ET texte (jamais la couleur seule). */
export function confidenceLevel(c: number): { tone: 'success' | 'warn' | 'danger'; label: string } {
  if (c >= 0.8) return { tone: 'success', label: 'élevée' };
  if (c >= 0.5) return { tone: 'warn', label: 'moyenne' };
  return { tone: 'danger', label: 'faible' };
}
