import { apiDelete, apiGet, apiPatch, apiPost, apiPostForm, apiPut } from '../../lib/api.js';

/**
 * Client de l'API interne des propositions (`/v1/proposals`, lot 9 ;
 * docs/contrats/07-api.md §7, 11-propositions.md).
 *
 * Les montants arrivent en CHAÎNES de centimes (bigint sérialisés par l'API) :
 * l'interface les formate (`lib/money.ts` → `formatCents`) sans jamais les
 * recalculer. Le serveur (moteur de tarification) calcule, l'écran affiche.
 */

export const PROPOSAL_STATUSES = [
  'DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED',
  'PENDING_SIGNATURE', 'SIGNED', 'CONVERTED', 'EXPIRED', 'DECLINED', 'WITHDRAWN',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type Cents = string | number | null;
export type AcceptanceMode = 'DOCUSEAL_SIGNATURE' | 'CLICK_ACCEPT';
export type RecipientRole = 'DECISION_MAKER' | 'SIGNER' | 'READER';

export interface ProposalListItem {
  id: string; number: string; title: string; status: ProposalStatus | string; customerId: string; ownerUserId: string;
  expiresAt: string | null; oneTimeCents: Cents; monthlyCents: Cents; commitmentTotalCents: Cents; commitmentMonths: number | null;
  winProbability: number | null; sentAt: string | null; lastActivityAt: string | null; contractId: string | null; updatedAt: string;
  customer: { name: string; commercialStatus?: string | null };
  owner: { fullName: string | null } | null;
}

export interface Bucket { htCents: Cents; vatCents: Cents; ttcCents: Cents }
export interface QuotedLine {
  key: string; label: string; group: string; recurrence: string; unit: string; quantity: number;
  unitPriceCents: Cents; totalHtCents: Cents; priceStatus: 'VALIDATED' | 'TO_VALIDATE' | string; priceFrom: boolean;
}
export interface PendingValidation { scope: 'LINE' | 'RULE' | 'SECTION' | 'CHOICE'; key: string; label: string; choiceValue?: string }
export interface Quote {
  choices: Record<string, string>; quantities: Record<string, number>; selectedOptions: string[]; commitmentMonths: number;
  lines: QuotedLine[]; infoLines: QuotedLine[];
  totals: { oneTime: Bucket; monthly: Bucket; quarterly: Bucket; yearly: Bucket; commitment: Bucket };
  errors: string[]; blockingValidations: PendingValidation[];
}

export type LinePricing = { unitPriceCents: number } | { dependsOn: string; byChoice: Record<string, number> };
export interface DefLine {
  key: string; label: string; description?: string; kind: 'REQUIRED' | 'OPTIONAL' | 'SETUP' | 'INFO'; unit: string;
  recurrence: 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'INFO';
  quantity?: { default: number | string; min: number; max?: number; maxFrom?: string; linkedTo?: string; editableByClient: boolean };
  pricing: LinePricing; priceFrom?: boolean; priceStatus: 'VALIDATED' | 'TO_VALIDATE';
  priceStatusByChoice?: Record<string, 'VALIDATED' | 'TO_VALIDATE'>; priceSource?: string; setupLineKey?: string;
  indexation?: unknown; group: 'RECURRING' | 'SETUP' | 'OPTIONS' | 'YEARLY' | 'OUT_OF_SCOPE';
}
export interface DefChoice {
  key: string; label: string; editableByClient: boolean; priceStatus?: 'VALIDATED' | 'TO_VALIDATE'; note?: string;
  options: { value: string; label: string; description?: string; default?: boolean; commitmentMonths?: number }[];
}
export type DefRule = { type: string; key: string; [k: string]: unknown };
export interface PricingDefinition { choices: DefChoice[]; lines: DefLine[]; rules: DefRule[]; vatRatePercent: number }

export type BlockType = 'RICH_TEXT' | 'IMAGE' | 'VIDEO' | 'PRICING_TABLE' | 'TIMELINE' | 'TEAM' | 'REFERENCES' | 'FAQ' | 'TERMS' | 'SIGNATURE';
export interface Block { type: BlockType; content: Record<string, unknown> }
export type SectionKind = 'COVER' | 'LIBRARY' | 'TEXT' | 'CLIENT_INPUT' | 'PRICING' | 'TERMS' | 'SIGNATURE';
export interface Section {
  key: string; title: string; kind: SectionKind; position?: number; optional: boolean; excluded: boolean;
  validationStatus?: 'VALIDATED' | 'TO_VALIDATE'; libraryItemKey: string | null; guidance: string | null; aiPendingReview?: boolean;
  aiSources?: { url: string; title?: string }[] | null;
  blocks: Block[];
}

export interface Recipient { id: string; contactId: string | null; fullName: string; email: string; jobTitle: string | null; role: RecipientRole; signingOrder: number }
export interface ReadinessIssue { code: string; message: string; sectionKey?: string }

export interface ProposalDetail {
  proposal: {
    id: string; number: string; title: string; status: ProposalStatus | string; customerId: string; ownerUserId: string;
    templateId: string | null; acceptanceMode: AcceptanceMode; validityDays: number; fixedExpiryDate: string | null;
    expiresAt: string | null; sensitive: boolean; reviewRequired: boolean; reviewReason: string | null;
    followUpsEnabled: boolean; followUpConfig: { noOpenAfterDays: number; noDecisionAfterDays: number; beforeExpiryDays: number } | null;
    mergeContext: Record<string, string | number>; winProbability: number | null; desiredStartDate: string | null;
    conversionError: string | null; declineReasonCode: string | null; declineReason: string | null; withdrawReason: string | null;
    contractId: string | null; sentAt: string | null; firstViewedAt: string | null; lastActivityAt: string | null;
    acceptedAt: string | null; signedAt: string | null; convertedAt: string | null; signedProposalIsContract?: boolean;
    customer: { id: string; name: string; legalName: string | null; siren: string | null; commercialStatus?: string | null };
    owner: { id: string; fullName: string | null; email: string | null } | null;
  };
  version: {
    id: string; number: number; title: string; lockedAt: string | null; supersededAt: string | null; pdfSha256: string | null;
    contentSha256: string | null; terms: { id: string; versionNumber: number; title: string } | null;
    sections: Section[]; pricingDefinition: PricingDefinition;
  };
  versions: { id: string; versionNumber: number; lockedAt: string | null; supersededAt: string | null; changeSummary: string | null; createdAt: string }[];
  recipients: Recipient[];
  selection: { choices: Record<string, string>; quantities: Record<string, number>; selectedOptions: string[] };
  quote: Quote;
  readiness: { issues: ReadinessIssue[]; reviewReasons: string[]; counters: Record<string, number | boolean> };
  allowedEvents: string[];
  stats: ViewStat[];
  signature: null | {
    id: string; status: string; delivery: string; sentPdfSha256: string | null; signedPdfSha256: string | null;
    auditTrailSha256: string | null; hashRelation: string | null; createdAt: string; errorMessage: string | null;
  };
}

export interface ViewStat { sectionKey: string; opens: number; totalDurationMs: string | number; pdfDownloads: number; newViewers: number; lastViewedAt: string | null }
export interface Tracking {
  id: string; firstViewedAt: string | null; lastActivityAt: string | null; sentAt: string | null;
  stats: ViewStat[];
  events: { id: string; recipientId: string | null; kind: string; sectionKey: string | null; durationMs: number | null; ipTruncated: string | null; occurredAt: string }[];
  deliveries: { id: string; recipientId: string; kind: string; subject: string; error: string | null; sentAt: string; recipient?: { fullName: string; email: string } }[];
  followUps: { id: string; kind: string; dueAt: string; status: string; sentAt: string | null; skipReason: string | null }[];
  lifecycle: { id: string; fromStatus: string | null; toStatus: string; event: string | null; reason: string | null; actorKind: string; occurredAt: string }[];
}
export interface ProposalComment {
  id: string; parentId: string | null; sectionKey: string | null; authorKind: 'CLIENT' | 'INTERNAL'; authorName: string; body: string; createdAt: string;
}

export interface CreateProposalBody {
  customerId: string; templateSlug?: string; title?: string; acceptanceMode?: AcceptanceMode; contactIds?: string[];
}
export interface RecipientBody { contactId?: string | null; fullName: string; email: string; jobTitle?: string | null; role: RecipientRole; signingOrder?: number }
export interface SelectionBody { choices?: Record<string, string>; quantities?: Record<string, number>; selectedOptions?: string[] }

const P = '/v1/proposals';
const id = (x: string) => `${P}/${encodeURIComponent(x)}`;

export const proposalsApi = {
  list: (q: { status?: string; customerId?: string; mine?: boolean }) => {
    const sp = new URLSearchParams();
    if (q.status) sp.set('status', q.status);
    if (q.customerId) sp.set('customerId', q.customerId);
    if (q.mine) sp.set('mine', 'true');
    const s = sp.toString();
    return apiGet<{ items: ProposalListItem[] }>(s ? `${P}?${s}` : P);
  },
  create: (b: CreateProposalBody) => apiPost<ProposalDetail>(P, b),
  get: (pid: string) => apiGet<ProposalDetail>(id(pid)),
  update: (pid: string, b: Record<string, unknown>) => apiPatch<ProposalDetail>(id(pid), b),
  putSections: (pid: string, sections: Section[]) => apiPut<ProposalDetail>(`${id(pid)}/sections`, { sections }),
  putPricing: (pid: string, def: PricingDefinition) => apiPut<ProposalDetail>(`${id(pid)}/pricing`, def),
  select: (pid: string, b: SelectionBody) => apiPut<ProposalDetail>(`${id(pid)}/selection`, b),
  addRecipient: (pid: string, b: RecipientBody) => apiPost<ProposalDetail>(`${id(pid)}/recipients`, b),
  removeRecipient: async (pid: string, rid: string) => {
    await apiDelete(`${id(pid)}/recipients/${encodeURIComponent(rid)}`);
  },
  importDocx: (pid: string, file: File) => {
    const f = new FormData();
    f.append('file', file);
    return apiPostForm<ProposalDetail>(`${id(pid)}/import-docx`, f);
  },
  action: (pid: string, path: string, body: unknown = {}) => apiPost<ProposalDetail>(`${id(pid)}/${path}`, body),
  resend: (pid: string, recipientId?: string) => apiPost<ProposalDetail>(`${id(pid)}/resend`, recipientId ? { recipientId } : {}),
  validatePrice: (pid: string, b: { scope: 'LINE' | 'RULE' | 'CHOICE'; key: string; choiceValue?: string }) =>
    apiPost<ProposalDetail>(`${id(pid)}/pricing/validate`, b),
  validateSection: (pid: string, key: string) => apiPost<ProposalDetail>(`${id(pid)}/sections/${encodeURIComponent(key)}/validate`, {}),
  startSignature: (pid: string) => apiPost<unknown>(`${id(pid)}/start-signature`, {}),
  convert: (pid: string) => apiPost<{ contractId: string; created: boolean } | null>(`${id(pid)}/convert`, {}),
  tracking: (pid: string) => apiGet<Tracking>(`${id(pid)}/tracking`),
  comments: (pid: string) => apiGet<{ items: ProposalComment[] }>(`${id(pid)}/comments`),
  reply: (pid: string, b: { body: string; parentId?: string; sectionKey?: string }) => apiPost<ProposalComment>(`${id(pid)}/comments`, b),
  preview: (pid: string) => apiGet<{ html: string }>(`${id(pid)}/preview`),
  pdfUrl: (pid: string) => `${id(pid)}/pdf`,
  validateAiSection: (pid: string, key: string) => apiPost<ProposalDetail>(`${id(pid)}/sections/${encodeURIComponent(key)}/ai-validate`, {}),
};

// --- Administration ------------------------------------------------------------

export interface TemplateSummary {
  id: string; slug: string; name: string; description: string | null; acceptanceMode: AcceptanceMode;
  contractTemplateSlug: string | null; signedProposalIsContract: boolean; seedVersion: number | null;
  userModifiedAt: string | null; archivedAt: string | null; pendingValidations: number;
}
export type TemplateDetail = Omit<TemplateSummary, 'pendingValidations'> & {
  target?: string | null; validityDays: number; providerCountersign?: boolean;
  definition: PricingDefinition;
  sections: { key: string; title: string; kind: string; optional: boolean; validationStatus: string; libraryItemKey: string | null; position: number }[];
  pendingValidations: PendingValidation[];
  lines: unknown[];
};
export interface LibraryItem {
  id: string; key: string; title: string; folder: string; body: string; requiresLegalReview: boolean; version: number;
  seedVersion: number | null; userModifiedAt: string | null; updatedAt: string;
}
export interface TermsVersion { id: string; versionNumber: number; title: string; sha256: string; createdAt: string }
export interface ContractTemplateRow { id: string; name: string; category: string; status: string; versionCount: number; slug?: string | null }

const A = '/v1/proposal-admin';
export const proposalAdminApi = {
  templates: () => apiGet<{ items: TemplateSummary[] }>(`${A}/templates`),
  template: (slug: string) => apiGet<TemplateDetail>(`${A}/templates/${encodeURIComponent(slug)}`),
  updateTemplate: (slug: string, b: Record<string, unknown>) => apiPatch<unknown>(`${A}/templates/${encodeURIComponent(slug)}`, b),
  updateLine: (slug: string, key: string, b: { label?: string; pricing?: LinePricing; priceSource?: string }) =>
    apiPatch<unknown>(`${A}/templates/${encodeURIComponent(slug)}/lines/${encodeURIComponent(key)}`, b),
  library: () => apiGet<{ items: LibraryItem[] }>(`${A}/library`),
  createLibraryItem: (b: { key: string; title: string; folder: string; body: string; requiresLegalReview?: boolean }) => apiPost<LibraryItem>(`${A}/library`, b),
  updateLibraryItem: (key: string, b: Partial<{ title: string; folder: string; body: string; requiresLegalReview: boolean }>) =>
    apiPatch<LibraryItem>(`${A}/library/${encodeURIComponent(key)}`, b),
  terms: () => apiGet<{ items: TermsVersion[] }>(`${A}/terms`),
  publishTerms: (b: { title: string; body: string }) => apiPost<TermsVersion>(`${A}/terms`, b),
  setContractTemplateSlug: (templateId: string, slug: string | null) =>
    apiPut<{ id: string; slug: string | null }>(`${A}/contract-templates/${encodeURIComponent(templateId)}/slug`, { slug }),
  contractTemplates: () => apiGet<{ items: ContractTemplateRow[] }>('/v1/templates'),
};

/** Empreinte SHA-256 hexadécimale (détection des clauses dérogatoires) ; null si WebCrypto est indisponible. */
export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
