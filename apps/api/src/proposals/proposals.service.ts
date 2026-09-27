import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { nextProposalSequence, uuidv7, withScope, type Scope } from '@lsi/persistence';
import { allowedProposalEvents, formatProposalNumber, type ProposalEvent } from '@lsi/domain';
import type { ProposalPricingDefinition } from '@lsi/pricing';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { enforcePriceStatuses, PricingDefinitionSchema, templateDefinition, validateInDefinition } from './pricing-definition.js';
import { sha256Hex, SectionsInputSchema, type SectionInput } from './proposal-content.js';
import {
  computeState,
  loadProposal,
  loadTemplateDefinition,
  parisDay,
  proposalSettingsFrom,
  selectionOf,
  type ComputedState,
  type LoadedProposal,
  type ProposalSettings,
  type SelectionInput,
} from './proposal-state.js';
import { domainError, persistProposalTransition, toProposalSnapshot } from './proposal-transition.js';
import { quoteView } from './proposal-views.js';
import { docxToSections, DocxImportError } from './docx-import.js';
import type { CreateProposal, ListProposals, RecipientInput, SelectionBody, UpdateProposal } from './proposals.schemas.js';

/**
 * Propositions — côté LSI (commercial, valideur, lecteur). Brief §12.1-12.4.
 *
 * Toute méthode reçoit le Scope de la session (RLS tenant + portefeuille) ;
 * une proposition hors portefeuille n'existe pas (404). Les transitions
 * passent par `persistProposalTransition` (machine + journal + webhooks) ;
 * les compteurs de préparation viennent de `computeState`, seul calcul de
 * l'état d'une proposition.
 */

/** Tableau de prix d'une proposition vierge : à définir, donc bloquant (TO_VALIDATE). */
const BLANK_DEFINITION: ProposalPricingDefinition = {
  vatRatePercent: 20,
  choices: [
    {
      key: 'engagement',
      label: 'Durée d’engagement',
      editableByClient: true,
      options: [
        { value: '12', label: '12 mois', default: true, commitmentMonths: 12 },
        { value: '24', label: '24 mois', commitmentMonths: 24 },
        { value: '36', label: '36 mois', commitmentMonths: 36 },
      ],
    },
  ],
  lines: [
    {
      key: 'prestation',
      label: 'Prestation',
      kind: 'REQUIRED',
      unit: 'forfait / mois',
      recurrence: 'MONTHLY',
      group: 'RECURRING',
      quantity: { default: 1, min: 1, max: 1, editableByClient: false },
      pricing: { unitPriceCents: 0 },
      priceStatus: 'TO_VALIDATE',
      priceSource: 'À définir',
    },
  ],
  rules: [],
};

const BLANK_SECTIONS: SectionInput[] = [
  { key: 'couverture', title: 'Couverture', kind: 'COVER', blocks: [{ type: 'RICH_TEXT', content: { markdown: '# Proposition\n\n**{{client.raisonSociale}}**\n\nProposition n° {{proposition.numero}}' } }] },
  { key: 'contexte', title: 'Votre contexte', kind: 'CLIENT_INPUT', blocks: [{ type: 'RICH_TEXT', content: { markdown: '' } }] },
  { key: 'investissement', title: 'Votre investissement', kind: 'PRICING', blocks: [{ type: 'PRICING_TABLE', content: {} }] },
  { key: 'cgv', title: 'Conditions générales de vente', kind: 'TERMS', blocks: [{ type: 'TERMS', content: {} }] },
  { key: 'signature', title: 'Acceptation et signature', kind: 'SIGNATURE', blocks: [{ type: 'SIGNATURE', content: {} }] },
];

/** Statuts où le contenu (version courante non figée) se modifie. */
const EDITABLE = ['DRAFT'];

export function actorOf(scope: Scope): string | null {
  return /^[0-9a-f-]{36}$/i.test(scope.userId) ? scope.userId : null;
}

@Injectable()
export class ProposalsService {
  constructor(private readonly config: TenantConfigService) {}

  /** Module derrière `contrats.proposals.enabled` (brief §12, règle 4) : désactivé = inexistant. */
  async assertEnabled(scope: Scope): Promise<void> {
    if (!(await this.config.isEnabled(scope, 'contrats.proposals.enabled'))) {
      throw new NotFoundException({ code: 'PROPOSALS_DISABLED', detail: 'Le module Propositions n’est pas activé pour ce tenant (contrats.proposals.enabled).' });
    }
  }

  async settings(scope: Scope): Promise<ProposalSettings> {
    return proposalSettingsFrom(await this.config.settings(scope));
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  async list(scope: Scope, q: ListProposals) {
    await this.assertEnabled(scope);
    return withScope(scope, async (tx) => {
      const where: Record<string, unknown> = {};
      if (q.status) where.status = { in: q.status.split(',') };
      if (q.customerId) where.customerId = q.customerId;
      if (q.mine === 'true') where.ownerUserId = scope.userId;
      const items = await tx.proposal.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: q.limit ?? 50,
        select: {
          id: true, number: true, title: true, status: true, customerId: true, ownerUserId: true, expiresAt: true,
          oneTimeCents: true, monthlyCents: true, commitmentTotalCents: true, commitmentMonths: true, winProbability: true,
          sentAt: true, lastActivityAt: true, contractId: true, updatedAt: true,
          customer: { select: { name: true, commercialStatus: true } },
          owner: { select: { fullName: true } },
        },
      });
      return { items };
    });
  }

  async get(scope: Scope, id: string, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, (tx) => this.detail(tx, id, settings, now));
  }

  async detail(tx: any, id: string, settings: ProposalSettings, now: Date) {
    const loaded = await loadProposal(tx, id);
    const state = computeState(loaded, settings, now, { templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
    const { proposal, version, recipients } = loaded;
    const versions = await tx.proposalVersion.findMany({
      where: { proposalId: id },
      orderBy: { versionNumber: 'asc' },
      select: { id: true, versionNumber: true, lockedAt: true, supersededAt: true, pdfSha256: true, contentSha256: true, changeSummary: true, createdAt: true },
    });
    const stats = await tx.proposalViewStat.findMany({ where: { proposalId: id } });
    const signature = await tx.proposalSignatureRequest.findFirst({
      where: { proposalId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, delivery: true, sentPdfSha256: true, signedPdfSha256: true, auditTrailSha256: true, hashRelation: true, createdAt: true, errorMessage: true },
    });
    const snapshot = { ...toProposalSnapshot(proposal, state.counters) };
    return {
      proposal: {
        ...proposal,
        mergeContext: proposal.mergeContext,
      },
      version: {
        id: version.id,
        number: version.versionNumber,
        title: version.title,
        lockedAt: version.lockedAt,
        supersededAt: version.supersededAt,
        pdfSha256: version.pdfSha256,
        contentSha256: version.contentSha256,
        terms: version.terms ? { id: version.terms.id, versionNumber: version.terms.versionNumber, title: version.terms.title } : null,
        sections: version.sections.map((s: any) => ({
          key: s.key, title: s.title, kind: s.kind, position: s.position, optional: s.optional, excluded: s.excluded,
          validationStatus: s.validationStatus, libraryItemKey: s.libraryItemKey, guidance: s.guidance, aiPendingReview: s.aiPendingReview,
          blocks: s.blocks.map((b: any) => ({ type: b.type, content: b.content })),
        })),
        pricingDefinition: state.definition,
      },
      versions,
      recipients: recipients.map((r: any) => ({ id: r.id, contactId: r.contactId, fullName: r.fullName, email: r.email, jobTitle: r.jobTitle, role: r.role, signingOrder: r.signingOrder })),
      selection: state.selection,
      quote: quoteView(state.quote),
      readiness: { issues: state.issues, reviewReasons: state.reviewReasons, counters: state.counters },
      allowedEvents: allowedProposalEvents(snapshot, now),
      stats,
      signature,
    };
  }

  // -------------------------------------------------------------------------
  // Création
  // -------------------------------------------------------------------------

  async create(scope: Scope, body: CreateProposal, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    const owner = actorOf(scope);
    if (!owner) throw new BadRequestException('Session sans utilisateur : création impossible');
    return withScope(scope, async (tx) => {
      // customerId est un FILTRE vérifié contre le scope (RLS) : hors portefeuille → 404.
      const customer = await tx.customer.findUnique({ where: { id: body.customerId } });
      if (!customer) throw new NotFoundException('Client introuvable');
      const template = body.templateSlug
        ? await tx.proposalTemplate.findUnique({
            where: { tenantId_slug: { tenantId: scope.tenantId, slug: body.templateSlug } },
            include: { sections: { orderBy: { position: 'asc' } }, lines: true },
          })
        : null;
      if (body.templateSlug && (!template || template.archivedAt)) throw new NotFoundException('Modèle de proposition introuvable');

      const year = Number(parisDay(now).slice(0, 4));
      const number = formatProposalNumber(year, await nextProposalSequence(tx, scope.tenantId, year));
      const id = uuidv7();
      const versionId = uuidv7();
      const title = body.title ?? `${template ? template.name : 'Proposition'} — ${customer.legalName ?? customer.name}`;
      await tx.proposal.create({
        data: {
          id, tenantId: scope.tenantId, customerId: customer.id, number, title,
          templateId: template?.id ?? null, ownerUserId: owner, status: 'DRAFT',
          acceptanceMode: body.acceptanceMode ?? template?.acceptanceMode ?? 'DOCUSEAL_SIGNATURE',
          currentVersionId: versionId,
          validityDays: template?.validityDays ?? settings.defaultValidityDays,
          followUpConfig: (template?.followUps as object | undefined) ?? undefined,
          mergeContext: body.mergeContext ?? {},
          signedProposalIsContract: template?.signedProposalIsContract ?? false,
          createdAt: now, updatedAt: now, createdByUserId: owner, updatedByUserId: owner,
        },
      });
      const terms = await tx.proposalTerms.findFirst({ where: { tenantId: scope.tenantId }, orderBy: { versionNumber: 'desc' } });
      await tx.proposalVersion.create({
        data: {
          id: versionId, tenantId: scope.tenantId, customerId: customer.id, proposalId: id, versionNumber: 1, title,
          pricingDefinition: (template ? templateDefinition(template) : BLANK_DEFINITION) as object,
          pricingSettings: settings.pricing as object,
          termsId: terms?.id ?? null, createdAt: now, createdByUserId: owner,
        },
      });

      let sections: SectionInput[] = BLANK_SECTIONS;
      if (template) {
        const keys = template.sections.map((s: any) => s.libraryItemKey).filter(Boolean) as string[];
        const library = new Map(
          (await tx.contentLibraryItem.findMany({ where: { tenantId: scope.tenantId, key: { in: keys } } })).map((l: any) => [l.key, l]),
        );
        sections = template.sections.map((s: any) => fromTemplateSection(s, library));
      }
      await this.writeSections(tx, { tenantId: scope.tenantId, customerId: customer.id, proposalId: id, versionId }, sections, new Map(
        (template?.sections ?? []).map((s: any) => [s.key, s.validationStatus]),
      ));

      for (const [i, contactId] of (body.contactIds ?? []).entries()) {
        const c = await tx.customerContact.findUnique({ where: { id: contactId } });
        if (!c || c.customerId !== customer.id) throw new NotFoundException('Contact introuvable');
        await tx.proposalRecipient.create({
          data: {
            id: uuidv7(), tenantId: scope.tenantId, customerId: customer.id, proposalId: id, contactId: c.id,
            fullName: `${c.firstName} ${c.lastName}`, email: c.email.toLowerCase(), jobTitle: c.jobTitle,
            role: c.isSignatory ? 'SIGNER' : 'DECISION_MAKER', signingOrder: i, createdAt: now, updatedAt: now,
          },
        });
      }
      await this.refreshSummary(tx, id, settings, now);
      return this.detail(tx, id, settings, now);
    });
  }

  /** Remplace sections et blocs d'une version NON figée (le trigger refuse sinon). */
  async writeSections(
    tx: any,
    ids: { tenantId: string; customerId: string; proposalId: string; versionId: string },
    sections: readonly SectionInput[],
    validation: ReadonlyMap<string, string>,
  ): Promise<void> {
    await tx.proposalBlock.deleteMany({ where: { section: { versionId: ids.versionId } } });
    await tx.proposalSection.deleteMany({ where: { versionId: ids.versionId } });
    const rows = sections.map((s, position) => ({ s, id: uuidv7(), position }));
    await tx.proposalSection.createMany({
      data: rows.map(({ s, id, position }) => ({
        id, ...ids, position, key: s.key, title: s.title, kind: s.kind,
        libraryItemKey: s.libraryItemKey ?? null, guidance: s.guidance ?? null,
        optional: s.optional ?? false, excluded: s.excluded ?? false,
        // Le statut « à valider » ne se lève jamais en réécrivant la section.
        validationStatus: (validation.get(s.key) as 'VALIDATED' | 'TO_VALIDATE' | undefined) ?? 'VALIDATED',
      })),
    });
    const blocks = rows.flatMap(({ s, id }) =>
      s.blocks.map((b, position) => ({
        id: uuidv7(), tenantId: ids.tenantId, customerId: ids.customerId, proposalId: ids.proposalId,
        sectionId: id, position, type: b.type, content: (b.content ?? {}) as object,
      })),
    );
    if (blocks.length) await tx.proposalBlock.createMany({ data: blocks });
  }

  // -------------------------------------------------------------------------
  // Rédaction (brouillon)
  // -------------------------------------------------------------------------

  private async editable(tx: any, id: string): Promise<LoadedProposal> {
    const loaded = await loadProposal(tx, id);
    if (!EDITABLE.includes(loaded.proposal.status) || loaded.version.lockedAt) {
      throw new ConflictException({
        code: 'PROPOSAL_NOT_EDITABLE',
        detail: `Proposition ${loaded.proposal.status} : créer une nouvelle version (« réviser ») pour la modifier.`,
      });
    }
    return loaded;
  }

  async update(scope: Scope, id: string, body: UpdateProposal, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      // Probabilité et relances : pilotage commercial, modifiables tant que la proposition vit.
      const pilot = ['winProbability', 'followUpsEnabled', 'followUpConfig', 'desiredStartDate'];
      const contentChange = Object.keys(body).some((k) => !pilot.includes(k));
      if (contentChange && (!EDITABLE.includes(loaded.proposal.status) || loaded.version.lockedAt)) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_EDITABLE', detail: 'Seule une proposition en brouillon se modifie : la réviser.' });
      }
      const data: Record<string, unknown> = { updatedAt: now, updatedByUserId: actorOf(scope) ?? loaded.proposal.updatedByUserId };
      if (body.title !== undefined) data.title = body.title;
      if (body.acceptanceMode !== undefined) data.acceptanceMode = body.acceptanceMode;
      if (body.validityDays !== undefined) data.validityDays = body.validityDays;
      if (body.fixedExpiryDate !== undefined) data.fixedExpiryDate = body.fixedExpiryDate ? new Date(`${body.fixedExpiryDate}T00:00:00Z`) : null;
      if (body.sensitive !== undefined) data.sensitive = body.sensitive;
      if (body.mergeContext !== undefined) data.mergeContext = body.mergeContext;
      if (body.followUpsEnabled !== undefined) data.followUpsEnabled = body.followUpsEnabled;
      if (body.followUpConfig !== undefined) data.followUpConfig = body.followUpConfig ?? null;
      if (body.winProbability !== undefined) data.winProbability = body.winProbability;
      if (body.desiredStartDate !== undefined) data.desiredStartDate = body.desiredStartDate ? new Date(`${body.desiredStartDate}T00:00:00Z`) : null;
      await tx.proposal.update({ where: { id }, data });
      if (body.title !== undefined) await tx.proposalVersion.update({ where: { id: loaded.version.id }, data: { title: body.title } });
      await this.refreshSummary(tx, id, settings, now);
      return this.detail(tx, id, settings, now);
    });
  }

  async putSections(scope: Scope, id: string, raw: unknown, now: Date) {
    await this.assertEnabled(scope);
    const parsed = SectionsInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ statusCode: 400, message: parsed.error.issues.map((i) => i.message) });
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await this.editable(tx, id);
      const validation = new Map<string, string>(loaded.version.sections.map((s: any) => [s.key, s.validationStatus]));
      await this.writeSections(tx, { tenantId: loaded.proposal.tenantId, customerId: loaded.proposal.customerId, proposalId: id, versionId: loaded.version.id }, parsed.data.sections, validation);
      await tx.proposal.update({ where: { id }, data: { updatedAt: now } });
      return this.detail(tx, id, settings, now);
    });
  }

  async putPricing(scope: Scope, id: string, raw: unknown, now: Date) {
    await this.assertEnabled(scope);
    const parsed = PricingDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ statusCode: 400, message: parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`) });
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await this.editable(tx, id);
      const def = enforcePriceStatuses(parsed.data as ProposalPricingDefinition, loaded.version.pricingDefinition as ProposalPricingDefinition);
      await tx.proposalVersion.update({ where: { id: loaded.version.id }, data: { pricingDefinition: def as object } });
      await this.refreshSummary(tx, id, settings, now);
      return this.detail(tx, id, settings, now);
    });
  }

  /** Validation d'un prix « à valider » du tableau d'une proposition (administrateur, audité par l'intercepteur). */
  async validatePrice(scope: Scope, id: string, target: { scope: 'LINE' | 'RULE' | 'CHOICE'; key: string; choiceValue?: string | undefined }, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await this.editable(tx, id);
      const next = validateInDefinition(loaded.version.pricingDefinition as ProposalPricingDefinition, target);
      if (!next) throw new NotFoundException('Élément « à valider » introuvable');
      await tx.proposalVersion.update({ where: { id: loaded.version.id }, data: { pricingDefinition: next as object } });
      await this.refreshSummary(tx, id, settings, now);
      return this.detail(tx, id, settings, now);
    });
  }

  /** Configuration proposée par le commercial (brouillon ou prête). */
  async setSelection(scope: Scope, id: string, body: SelectionBody, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      if (!['DRAFT', 'READY'].includes(loaded.proposal.status)) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_EDITABLE', detail: 'Après l’envoi, la configuration appartient au client.' });
      }
      const prev = selectionOf(loaded.latestSelection);
      const input: SelectionInput = {
        choices: { ...prev.choices, ...(body.choices ?? {}) },
        quantities: { ...prev.quantities, ...(body.quantities ?? {}) },
        selectedOptions: body.selectedOptions ?? prev.selectedOptions,
      };
      const state = computeState(loaded, settings, now, { selection: input, templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
      await recordSelection(tx, loaded, state, { actorKind: 'INTERNAL', userId: actorOf(scope), recipientId: null }, now);
      return this.detail(tx, id, settings, now);
    });
  }

  async addRecipient(scope: Scope, id: string, body: RecipientInput, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      if (!['DRAFT', 'READY', 'IN_INTERNAL_REVIEW'].includes(loaded.proposal.status)) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_EDITABLE', detail: 'Les destinataires se fixent avant l’envoi (réviser pour en ajouter).' });
      }
      if (body.contactId) {
        const c = await tx.customerContact.findUnique({ where: { id: body.contactId } });
        if (!c || c.customerId !== loaded.proposal.customerId) throw new NotFoundException('Contact introuvable');
      }
      const r = await tx.proposalRecipient.createMany({
        data: [{
          id: uuidv7(), tenantId: loaded.proposal.tenantId, customerId: loaded.proposal.customerId, proposalId: id,
          contactId: body.contactId ?? null, fullName: body.fullName, email: body.email, jobTitle: body.jobTitle ?? null,
          role: body.role, signingOrder: body.signingOrder ?? 0, createdAt: now, updatedAt: now,
        }],
        skipDuplicates: true,
      });
      if (r.count === 0) throw new ConflictException({ code: 'RECIPIENT_EXISTS', detail: 'Ce destinataire est déjà présent.' });
      return this.detail(tx, id, settings, now);
    });
  }

  async removeRecipient(scope: Scope, id: string, recipientId: string, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      if (!['DRAFT', 'READY', 'IN_INTERNAL_REVIEW'].includes(loaded.proposal.status)) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_EDITABLE', detail: 'Les destinataires se fixent avant l’envoi.' });
      }
      const n = await tx.proposalRecipient.deleteMany({ where: { id: recipientId, proposalId: id } });
      if (n.count === 0) throw new NotFoundException('Destinataire introuvable');
      return this.detail(tx, id, settings, now);
    });
  }

  /** Validation d'une section « à valider » d'une proposition (administrateur, tracé). */
  async validateSection(scope: Scope, id: string, key: string, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await this.editable(tx, id);
      const n = await tx.proposalSection.updateMany({
        where: { versionId: loaded.version.id, key, validationStatus: 'TO_VALIDATE' },
        data: { validationStatus: 'VALIDATED' },
      });
      if (n.count === 0) throw new NotFoundException('Section « à valider » introuvable');
      await tx.proposal.update({ where: { id }, data: { updatedAt: now } });
      return this.detail(tx, id, settings, now);
    });
  }

  /**
   * Import d'un document Word comme point de départ (brief §12.3) : ses
   * sections remplacent les sections de texte libre du brouillon ; couverture,
   * contexte, bibliothèque, prix, CGV et signature sont conservés.
   */
  async importDocx(scope: Scope, id: string, docx: Buffer, now: Date) {
    await this.assertEnabled(scope);
    let imported: SectionInput[];
    try {
      imported = docxToSections(docx);
    } catch (e) {
      if (e instanceof DocxImportError) throw new BadRequestException(e.message);
      throw new BadRequestException('Document Word illisible.');
    }
    if (imported.length === 0) throw new BadRequestException('Aucun contenu exploitable dans ce document.');
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await this.editable(tx, id);
      const existing: SectionInput[] = loaded.version.sections.map((s: any) => ({
        key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded,
        libraryItemKey: s.libraryItemKey, guidance: s.guidance,
        blocks: s.blocks.map((b: any) => ({ type: b.type, content: b.content })),
      }));
      const keys = new Set(existing.filter((s) => s.kind !== 'TEXT').map((s) => s.key));
      const cover = existing.filter((s) => s.kind === 'COVER');
      const rest = existing.filter((s) => s.kind !== 'COVER' && s.kind !== 'TEXT');
      const renamed = imported.map((s) => (keys.has(s.key) ? { ...s, key: `import-${s.key}` } : s));
      const validation = new Map<string, string>(loaded.version.sections.map((s: any) => [s.key, s.validationStatus]));
      await this.writeSections(
        tx,
        { tenantId: loaded.proposal.tenantId, customerId: loaded.proposal.customerId, proposalId: id, versionId: loaded.version.id },
        [...cover, ...renamed, ...rest],
        validation,
      );
      await tx.proposal.update({ where: { id }, data: { updatedAt: now } });
      return this.detail(tx, id, settings, now);
    });
  }

  // -------------------------------------------------------------------------
  // Transitions internes (hors envoi, voir ProposalSendService)
  // -------------------------------------------------------------------------

  async transition(scope: Scope, id: string, event: ProposalEvent, now: Date, extra: Record<string, unknown> = {}) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const state = computeState(loaded, settings, now, { templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
      await persistProposalTransition(tx, id, event, { now, userId: actorOf(scope), readiness: state.counters, extra });
      if (event.type === 'WITHDRAW' || event.type === 'DECLINE') await cancelFollowUps(tx, id, now, event.type);
      return this.detail(tx, id, settings, now);
    });
  }

  async readiness(scope: Scope, id: string, now: Date) {
    await this.assertEnabled(scope);
    const settings = await this.settings(scope);
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const state = computeState(loaded, settings, now, { templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
      return { issues: state.issues, reviewReasons: state.reviewReasons, counters: state.counters, blocking: state.blocking };
    });
  }

  /** Montants synthèse (liste, pipeline) : configuration courante, recalculée par le moteur. */
  async refreshSummary(tx: any, id: string, settings: ProposalSettings, now: Date): Promise<ComputedState> {
    const loaded = await loadProposal(tx, id);
    const state = computeState(loaded, settings, now, { templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
    await tx.proposal.update({
      where: { id },
      data: {
        oneTimeCents: state.quote.oneTime.htCents,
        monthlyCents: state.quote.monthly.htCents,
        commitmentTotalCents: state.quote.commitment.htCents,
        commitmentMonths: state.quote.commitmentMonths,
        reviewRequired: state.counters.reviewRequired,
      },
    });
    return state;
  }

  // -------------------------------------------------------------------------
  // Suivi, commentaires
  // -------------------------------------------------------------------------

  async tracking(scope: Scope, id: string) {
    await this.assertEnabled(scope);
    return withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id }, select: { id: true, firstViewedAt: true, lastActivityAt: true, sentAt: true } });
      if (!p) throw new NotFoundException('Proposition introuvable');
      const [stats, events, deliveries, followUps, lifecycle] = await Promise.all([
        tx.proposalViewStat.findMany({ where: { proposalId: id }, orderBy: { sectionKey: 'asc' } }),
        tx.proposalViewEvent.findMany({ where: { proposalId: id }, orderBy: { occurredAt: 'desc' }, take: 200 }),
        tx.proposalDelivery.findMany({ where: { proposalId: id }, orderBy: { sentAt: 'desc' }, include: { recipient: { select: { fullName: true, email: true } } } }),
        tx.proposalFollowUp.findMany({ where: { proposalId: id }, orderBy: { dueAt: 'asc' } }),
        tx.proposalLifecycleEvent.findMany({ where: { proposalId: id }, orderBy: { seq: 'asc' } }),
      ]);
      return { ...p, stats, events, deliveries, followUps, lifecycle };
    });
  }

  async comments(scope: Scope, id: string) {
    await this.assertEnabled(scope);
    return withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id }, select: { id: true } });
      if (!p) throw new NotFoundException('Proposition introuvable');
      return { items: await tx.proposalComment.findMany({ where: { proposalId: id }, orderBy: { createdAt: 'asc' } }) };
    });
  }

  async reply(scope: Scope, id: string, body: { body: string; parentId?: string | undefined; sectionKey?: string | undefined }, now: Date) {
    await this.assertEnabled(scope);
    const author = actorOf(scope);
    if (!author) throw new BadRequestException('Session sans utilisateur');
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const me = await tx.user.findUnique({ where: { id: author }, select: { fullName: true } });
      const authorName = `${me?.fullName ?? 'LSI Maintenance'} (LSI Maintenance)`;
      if (body.parentId) {
        const parent = await tx.proposalComment.findUnique({ where: { id: body.parentId } });
        if (!parent || parent.proposalId !== id) throw new NotFoundException('Commentaire introuvable');
      }
      const row = await tx.proposalComment.create({
        data: {
          id: uuidv7(), tenantId: loaded.proposal.tenantId, customerId: loaded.proposal.customerId, proposalId: id,
          versionId: loaded.version.id, sectionKey: body.sectionKey ?? null, parentId: body.parentId ?? null,
          authorKind: 'INTERNAL', authorUserId: author, authorName, body: body.body, createdAt: now,
        },
      });
      await tx.proposal.update({ where: { id }, data: { lastActivityAt: now } });
      return row;
    });
  }
}

// ---------------------------------------------------------------------------
// Fonctions partagées (page publique, envoi)
// ---------------------------------------------------------------------------

/** Enregistre une configuration recalculée (append-only) et met à jour la synthèse. */
export async function recordSelection(
  tx: any,
  loaded: LoadedProposal,
  state: ComputedState,
  actor: { actorKind: 'INTERNAL' | 'CLIENT' | 'SYSTEM'; userId: string | null; recipientId: string | null },
  now: Date,
) {
  const q = state.quote;
  const row = await tx.proposalSelection.create({
    data: {
      id: uuidv7(), tenantId: loaded.proposal.tenantId, customerId: loaded.proposal.customerId, proposalId: loaded.proposal.id,
      versionId: loaded.version.id, choices: state.selection.choices, quantities: state.selection.quantities,
      selectedOptions: state.selection.selectedOptions,
      oneTimeCents: q.oneTime.htCents, monthlyCents: q.monthly.htCents, quarterlyCents: q.quarterly.htCents,
      yearlyCents: q.yearly.htCents, commitmentTotalCents: q.commitment.htCents, commitmentMonths: q.commitmentMonths,
      errors: [...q.errors], actorKind: actor.actorKind, userId: actor.userId, recipientId: actor.recipientId, createdAt: now,
    },
  });
  await tx.proposal.update({
    where: { id: loaded.proposal.id },
    data: {
      oneTimeCents: q.oneTime.htCents, monthlyCents: q.monthly.htCents, commitmentTotalCents: q.commitment.htCents,
      commitmentMonths: q.commitmentMonths, reviewRequired: state.counters.reviewRequired,
    },
  });
  return row;
}

export async function cancelFollowUps(tx: any, proposalId: string, now: Date, reason: string): Promise<void> {
  await tx.proposalFollowUp.updateMany({
    where: { proposalId, status: 'PLANNED' },
    data: { status: 'CANCELLED', skipReason: reason, updatedAt: now },
  });
}

function fromTemplateSection(s: any, library: Map<string, any>): SectionInput {
  const base = {
    key: s.key, title: s.title, kind: s.kind, optional: s.optional, libraryItemKey: s.libraryItemKey ?? null,
    guidance: s.guidance ?? null,
  } as const;
  switch (s.kind) {
    case 'COVER':
    case 'TEXT':
      return { ...base, blocks: [{ type: 'RICH_TEXT', content: { markdown: s.body ?? '' } }] };
    case 'LIBRARY': {
      const lib = library.get(s.libraryItemKey);
      const body = lib?.body ?? '[à compléter]';
      return { ...base, blocks: [{ type: 'RICH_TEXT', content: { markdown: body, sourceSha256: sha256Hex(body) } }] };
    }
    case 'CLIENT_INPUT':
      return { ...base, blocks: [{ type: 'RICH_TEXT', content: { markdown: '', ...(s.guidance ? { guidance: s.guidance } : {}) } }] };
    case 'PRICING':
      return { ...base, blocks: [{ type: 'PRICING_TABLE', content: s.body ? { intro: s.body } : {} }] };
    case 'TERMS':
      return { ...base, blocks: [{ type: 'TERMS', content: {} }] };
    default:
      return { ...base, blocks: [{ type: 'SIGNATURE', content: {} }] };
  }
}

export { domainError };
