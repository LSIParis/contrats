// Fichier GÉNÉRÉ par apps/api/scripts/generate-openapi.ts — ne pas modifier à la main.
// API Contrats 1.0.0 (OpenAPI 3.1.0).

export type Contract = {
  id: string;
  reference: string;
  title: string;
  type: "MAIN" | "AMENDMENT";
  status: "DRAFT" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "SENT_TO_CLIENT" | "IN_NEGOTIATION" | "ACCEPTED" | "PENDING_SIGNATURE" | "PARTIALLY_SIGNED" | "SIGNATURE_EXPIRED" | "SIGNED" | "ACTIVE" | "RENEWAL_DUE" | "TERMINATION_PENDING" | "EXPIRED" | "TERMINATED" | "RENEWED" | "CANCELLED" | "DECLINED" | "IMPORTED_PENDING_VALIDATION";
  origin: "NATIVE" | "IMPORTED" | "AI" | "PROPOSAL";
  category: string;
  customer: {
    id: string;
    name: string;
    externalRef: string | null;
    siren: string | null;
  };
  parentContractId: string | null;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  renewalMode: "NONE" | "TACIT" | "EXPRESS";
  /** Mode de la dernière demande de signature ; null si aucune. */
  signatureMode: "PDF" | "TEMPLATE" | null;
  signedAt: string | null;
  activatedAt: string | null;
  updatedAt: string;
};

export type ContractPage = {
  data: Array<{
    id: string;
    reference: string;
    title: string;
    type: "MAIN" | "AMENDMENT";
    status: "DRAFT" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "SENT_TO_CLIENT" | "IN_NEGOTIATION" | "ACCEPTED" | "PENDING_SIGNATURE" | "PARTIALLY_SIGNED" | "SIGNATURE_EXPIRED" | "SIGNED" | "ACTIVE" | "RENEWAL_DUE" | "TERMINATION_PENDING" | "EXPIRED" | "TERMINATED" | "RENEWED" | "CANCELLED" | "DECLINED" | "IMPORTED_PENDING_VALIDATION";
    origin: "NATIVE" | "IMPORTED" | "AI" | "PROPOSAL";
    category: string;
    customer: {
      id: string;
      name: string;
      externalRef: string | null;
      siren: string | null;
    };
    parentContractId: string | null;
    currency: string;
    startDate: string | null;
    endDate: string | null;
    renewalMode: "NONE" | "TACIT" | "EXPRESS";
    /** Mode de la dernière demande de signature ; null si aucune. */
    signatureMode: "PDF" | "TEMPLATE" | null;
    signedAt: string | null;
    activatedAt: string | null;
    updatedAt: string;
  }>;
  nextCursor: string | null;
};

export type ContractDates = {
  contractId: string;
  /** Date d’effet. */
  effectiveDate: string | null;
  /** Fin de la période en cours ; null pour une durée indéterminée. */
  currentPeriodEnd: string | null;
  /** Date limite de dénonciation de la période en cours. */
  noticeDeadline: string | null;
  nextPriceRevision: string | null;
  /** Début de la prochaine période si le contrat se renouvelle. */
  nextRenewal: string | null;
  renewalMode: "NONE" | "TACIT" | "EXPRESS";
  terminationEffectiveDate: string | null;
};

export type Deadline = {
  id: string;
  contractId: string;
  customerId: string;
  kind: string;
  /** Date calendaire AAAA-MM-JJ */
  dueDate: string;
  status: "OPEN" | "DONE";
  details: unknown | null;
};

export type DeadlinePage = {
  data: Array<{
    id: string;
    contractId: string;
    customerId: string;
    kind: string;
    /** Date calendaire AAAA-MM-JJ */
    dueDate: string;
    status: "OPEN" | "DONE";
    details: unknown | null;
  }>;
  nextCursor: string | null;
};

/** Barème à la date : montants en centimes, en chaînes (précision exacte). Détail : 04-tarification.md. */
export type Pricing = {
  contractId?: string;
  /** Date calendaire AAAA-MM-JJ */
  at?: string;
  currency?: string;
  lines?: Array<{
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

/** Devis : prix unitaire, total HT/TTC en centimes (chaînes), règle appliquée, trace. */
export type Quote = {
  [key: string]: unknown;
};

export type QuoteRequest = {
  contractId?: string;
  customerId?: string;
  articleCode: string;
  quantity: string;
  date?: string;
  ruleCode?: string;
  vatRatePercent?: string;
};

export type Webhook = {
  [key: string]: unknown;
};

export type CreateWebhookRequest = {
  url: string;
  description?: string;
  eventTypes: Array<"contract.activated" | "contract.signed" | "contract.renewal_due" | "contract.renewed" | "contract.terminated" | "pricing.revised" | "proposal.sent" | "proposal.viewed" | "proposal.accepted" | "proposal.signed" | "proposal.declined" | "proposal.expired" | "proposal.converted">;
};

/** Erreur RFC 9457 (`application/problem+json`). */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  [key: string]: unknown;
};

export type Proposal = {
  id: string;
  number: string;
  title: string;
  status: "DRAFT" | "IN_INTERNAL_REVIEW" | "READY" | "SENT" | "VIEWED" | "IN_DISCUSSION" | "ACCEPTED" | "PENDING_SIGNATURE" | "SIGNED" | "CONVERTED" | "EXPIRED" | "DECLINED" | "WITHDRAWN";
  acceptanceMode: "DOCUSEAL_SIGNATURE" | "CLICK_ACCEPT";
  customer: {
    id: string;
    name: string;
    externalRef: string | null;
    siren: string | null;
  };
  template: {
    slug: string;
    name: string;
  } | null;
  versionNumber: number | null;
  oneTimeCents: string | null;
  monthlyCents: string | null;
  commitmentTotalCents: string | null;
  commitmentMonths: number | null;
  /** Contrat généré à la conversion. */
  contractId: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  signedAt: string | null;
  convertedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProposalPage = {
  data: Array<{
    id: string;
    number: string;
    title: string;
    status: "DRAFT" | "IN_INTERNAL_REVIEW" | "READY" | "SENT" | "VIEWED" | "IN_DISCUSSION" | "ACCEPTED" | "PENDING_SIGNATURE" | "SIGNED" | "CONVERTED" | "EXPIRED" | "DECLINED" | "WITHDRAWN";
    acceptanceMode: "DOCUSEAL_SIGNATURE" | "CLICK_ACCEPT";
    customer: {
      id: string;
      name: string;
      externalRef: string | null;
      siren: string | null;
    };
    template: {
      slug: string;
      name: string;
    } | null;
    versionNumber: number | null;
    oneTimeCents: string | null;
    monthlyCents: string | null;
    commitmentTotalCents: string | null;
    commitmentMonths: number | null;
    /** Contrat généré à la conversion. */
    contractId: string | null;
    expiresAt: string | null;
    sentAt: string | null;
    acceptedAt: string | null;
    signedAt: string | null;
    convertedAt: string | null;
    declinedAt: string | null;
    expiredAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  nextCursor: string | null;
};

export type ProposalPricing = {
  proposalId: string;
  /** `ACCEPTED` : configuration figée à l’acceptation (barème du contrat) ; `PROPOSED` : tableau de la version courante. */
  source: "ACCEPTED" | "PROPOSED";
  versionNumber: number | null;
  oneTimeCents: string | null;
  monthlyCents: string | null;
  commitmentTotalCents: string | null;
  commitmentMonths: number | null;
  /** Tableau de prix (forme de l’annexe C, 11-propositions.md). */
  definition: unknown;
  /** Configuration retenue (acceptée) ; null si non acceptée. */
  selection: unknown;
  /** Empreinte de la configuration figée. */
  sha256: string | null;
  frozenAt: string | null;
};

export interface Transport {
  request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T>;
}

export class ContratsOperations {
  constructor(protected readonly transport: Transport) {}

  /** Contrats d’un client — scope `contracts:read`. */
  listClientContracts(clientRef: string, query: { cursor?: string; limit?: number; status?: string; type?: string } = {}): Promise<ContractPage> {
    return this.transport.request<ContractPage>('GET', `/api/v1/clients/${encodeURIComponent(clientRef)}/contracts`, { query, });
  }

  /** Détail d’un contrat : statut, origine, mode de signature — scope `contracts:read`. */
  getContract(id: string): Promise<Contract> {
    return this.transport.request<Contract>('GET', `/api/v1/contracts/${encodeURIComponent(id)}`, { });
  }

  /** Dates clés : effet, fin de période, date limite de préavis, prochaine révision, prochain renouvellement — scope `contracts:dates:read`. */
  getContractDates(id: string): Promise<ContractDates> {
    return this.transport.request<ContractDates>('GET', `/api/v1/contracts/${encodeURIComponent(id)}/dates`, { });
  }

  /** Barème applicable à une date, trace de calcul optionnelle — scope `pricing:read`. */
  getContractPricing(id: string, query: { at?: string; trace?: string } = {}): Promise<Pricing> {
    return this.transport.request<Pricing>('GET', `/api/v1/contracts/${encodeURIComponent(id)}/pricing`, { query, });
  }

  /** Prix pour un client, un article, une quantité et une date — scope `pricing:quote`. */
  quote(body: QuoteRequest): Promise<Quote> {
    return this.transport.request<Quote>('POST', `/api/v1/pricing/quote`, { body, });
  }

  /** Échéances à venir, tous contrats confondus — scope `contracts:dates:read`. */
  listDeadlines(query: { cursor?: string; limit?: number; from?: string; to?: string; kind?: string } = {}): Promise<DeadlinePage> {
    return this.transport.request<DeadlinePage>('GET', `/api/v1/deadlines`, { query, });
  }

  /** Propositions commerciales du tenant — scope `proposals:read`. */
  listProposals(query: { cursor?: string; limit?: number; status?: string; updatedSince?: string } = {}): Promise<ProposalPage> {
    return this.transport.request<ProposalPage>('GET', `/api/v1/proposals`, { query, });
  }

  /** Propositions d’un client ou d’un prospect — scope `proposals:read`. */
  listClientProposals(clientRef: string, query: { cursor?: string; limit?: number; status?: string; updatedSince?: string } = {}): Promise<ProposalPage> {
    return this.transport.request<ProposalPage>('GET', `/api/v1/clients/${encodeURIComponent(clientRef)}/proposals`, { query, });
  }

  /** Détail d’une proposition : statut, montants, dates, contrat généré — scope `proposals:read`. */
  getProposal(id: string): Promise<Proposal> {
    return this.transport.request<Proposal>('GET', `/api/v1/proposals/${encodeURIComponent(id)}`, { });
  }

  /** Tarif : configuration acceptée (figée) ou tableau proposé — scope `proposals:pricing:read`. */
  getProposalPricing(id: string): Promise<ProposalPricing> {
    return this.transport.request<ProposalPricing>('GET', `/api/v1/proposals/${encodeURIComponent(id)}/pricing`, { });
  }

  /** Abonnements aux webhooks sortants du tenant — scope `webhooks:manage`. */
  listWebhooks(): Promise<Webhook> {
    return this.transport.request<Webhook>('GET', `/api/v1/webhooks`, { });
  }

  /** Crée un abonnement ; le secret HMAC n’est renvoyé qu’une fois — scope `webhooks:manage`. */
  createWebhook(body: CreateWebhookRequest): Promise<Webhook> {
    return this.transport.request<Webhook>('POST', `/api/v1/webhooks`, { body, });
  }

  /** Désactive un abonnement — scope `webhooks:manage`. */
  disableWebhook(id: string): Promise<Webhook> {
    return this.transport.request<Webhook>('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`, { });
  }
}
