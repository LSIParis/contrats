import { NotFoundException } from '@nestjs/common';
import { quoteProposal, type PendingValidation, type PricingSettings, type ProposalPricingDefinition, type ProposalQuote } from '@lsi/pricing';
import {
  contentIssues,
  mergeValuesFor,
  pricingContextOf,
  sha256Hex as sha,
  type ReadinessIssue,
  type SectionWithBlocks,
} from './proposal-content.js';
import { templateDefinition, withTemplateValidations } from './pricing-definition.js';
import type { ReadinessCounters } from './proposal-transition.js';

/**
 * État calculé d'une proposition : chargement (dans la transaction scopée de
 * l'appelant), configuration courante, calcul par le moteur, valeurs de
 * fusion, contrôles de préparation et motifs de revue interne. UN seul
 * endroit, partagé par l'interface interne, la page publique, l'envoi, la
 * signature et la conversion : ils ne peuvent pas diverger.
 */

export interface ProposalSettings {
  readonly reviewDiscountPercent: number;
  readonly reviewAmountCents: number | null;
  readonly clickAcceptMaxCents: number;
  readonly defaultValidityDays: number;
  readonly followUps: { noOpenAfterDays: number; noDecisionAfterDays: number; beforeExpiryDays: number };
  readonly trackingRetentionDays: number;
  readonly linkGraceDays: number;
  readonly emailSubject: string;
  readonly emailBody: string;
  readonly lsiSignerUserId: string | null;
  readonly pricing: Partial<PricingSettings>;
}

export function proposalSettingsFrom(s: Record<string, unknown>): ProposalSettings {
  return {
    reviewDiscountPercent: s['proposals.reviewDiscountPercent'] as number,
    reviewAmountCents: s['proposals.reviewAmountCents'] as number | null,
    clickAcceptMaxCents: s['proposals.clickAcceptMaxCents'] as number,
    defaultValidityDays: s['proposals.defaultValidityDays'] as number,
    followUps: s['proposals.followUps'] as ProposalSettings['followUps'],
    trackingRetentionDays: s['proposals.trackingRetentionDays'] as number,
    linkGraceDays: s['proposals.linkGraceDays'] as number,
    emailSubject: s['proposals.emailSubject'] as string,
    emailBody: s['proposals.emailBody'] as string,
    lsiSignerUserId: s['proposals.lsiSignerUserId'] as string | null,
    pricing: { rounding: s['pricing.rounding'] as PricingSettings['rounding'] },
  };
}

export interface SelectionInput {
  readonly choices: Record<string, string>;
  readonly quantities: Record<string, number>;
  readonly selectedOptions: string[];
}

export const EMPTY_SELECTION: SelectionInput = { choices: {}, quantities: {}, selectedOptions: [] };

export function selectionOf(row: { choices: unknown; quantities: unknown; selectedOptions: unknown } | null | undefined): SelectionInput {
  if (!row) return EMPTY_SELECTION;
  return {
    choices: (row.choices ?? {}) as Record<string, string>,
    quantities: (row.quantities ?? {}) as Record<string, number>,
    selectedOptions: (row.selectedOptions ?? []) as string[],
  };
}

/** Jour calendaire de Paris (« YYYY-MM-DD »), V2-H22. */
export function parisDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function loadProposal(tx: any, proposalId: string, versionId?: string) {
  const proposal = await tx.proposal.findUnique({
    where: { id: proposalId },
    include: {
      customer: { select: { id: true, name: true, legalName: true, siren: true, externalRef: true, commercialStatus: true } },
      owner: { select: { id: true, fullName: true, email: true } },
    },
  });
  if (!proposal) throw new NotFoundException('Proposition introuvable');
  const vId = versionId ?? proposal.currentVersionId;
  const version = vId
    ? await tx.proposalVersion.findUnique({
        where: { id: vId },
        include: {
          sections: { orderBy: { position: 'asc' }, include: { blocks: { orderBy: { position: 'asc' } } } },
          terms: true,
        },
      })
    : null;
  if (!version) throw new NotFoundException('Version introuvable');
  const recipients = await tx.proposalRecipient.findMany({
    where: { proposalId },
    orderBy: [{ signingOrder: 'asc' }, { createdAt: 'asc' }],
    include: { contact: { select: { firstName: true, lastName: true } } },
  });
  const latest = await tx.proposalSelection.findFirst({ where: { versionId: version.id }, orderBy: { createdAt: 'desc' } });
  return { proposal, version, recipients, latestSelection: latest };
}
export type LoadedProposal = Awaited<ReturnType<typeof loadProposal>>;

/** Modèle d'origine (tenant) pour lever les « à valider » validés depuis — lecture interne seulement. */
export async function loadTemplateDefinition(tx: any, templateId: string | null): Promise<ProposalPricingDefinition | null> {
  if (!templateId) return null;
  const t = await tx.proposalTemplate.findUnique({ where: { id: templateId }, include: { lines: true, sections: true } });
  return t ? templateDefinition(t) : null;
}

export interface ComputedState {
  readonly definition: ProposalPricingDefinition;
  readonly selection: SelectionInput;
  readonly quote: ProposalQuote;
  readonly mergeValues: Record<string, string | number>;
  readonly issues: ReadinessIssue[];
  readonly blocking: PendingValidation[];
  readonly reviewReasons: string[];
  readonly counters: ReadinessCounters;
  readonly sections: SectionWithBlocks[];
}

export function computeState(
  loaded: LoadedProposal,
  settings: ProposalSettings,
  now: Date,
  opts: { templateDefinition?: ProposalPricingDefinition | null; selection?: SelectionInput; expiryDay?: string | null } = {},
): ComputedState {
  const { proposal, version, recipients } = loaded;
  const definition = withTemplateValidations(version.pricingDefinition as ProposalPricingDefinition, opts.templateDefinition ?? null);
  const selection = opts.selection ?? selectionOf(loaded.latestSelection);
  const mergeContext = (proposal.mergeContext ?? {}) as Record<string, unknown>;
  const quote = quoteProposal(
    definition,
    { ...selection, context: pricingContextOf(mergeContext) },
    { date: parisDay(now), settings: { ...settings.pricing, ...((version.pricingSettings ?? {}) as object) } },
  );

  const primary = recipients.find((r: any) => r.role !== 'READER') ?? recipients[0] ?? null;
  const [first, ...rest] = (primary?.fullName ?? '').trim().split(/\s+/);
  const contact = primary
    ? {
        firstName: primary.contact?.firstName ?? (rest.length ? first : null) ?? null,
        lastName: primary.contact?.lastName ?? (rest.length ? rest.join(' ') : first) ?? null,
      }
    : null;
  const expiryDay =
    opts.expiryDay ??
    (proposal.expiresAt
      ? parisDay(proposal.expiresAt)
      : proposal.fixedExpiryDate
        ? proposal.fixedExpiryDate.toISOString().slice(0, 10)
        : parisDay(new Date(now.getTime() + proposal.validityDays * 86_400_000)));
  const mergeValues = mergeValuesFor({
    customer: proposal.customer,
    contact,
    ownerName: proposal.owner?.fullName ?? null,
    number: proposal.number,
    expiryDay,
    mergeContext,
    quote,
  });

  const sections: SectionWithBlocks[] = version.sections.map((s: any) => ({
    key: s.key,
    title: s.title,
    kind: s.kind,
    position: s.position,
    optional: s.optional,
    excluded: s.excluded,
    validationStatus: s.validationStatus,
    libraryItemKey: s.libraryItemKey,
    guidance: s.guidance,
    aiPendingReview: s.aiPendingReview,
    blocks: s.blocks.map((b: any) => ({ position: b.position, type: b.type, content: b.content })),
  }));
  const issues = contentIssues(version.title, sections, mergeValues, !!version.termsId);
  for (const e of quote.errors) issues.push({ code: 'PRICING', message: e });
  if (proposal.acceptanceMode === 'CLICK_ACCEPT' && quote.commitment.htCents >= BigInt(settings.clickAcceptMaxCents)) {
    issues.push({
      code: 'CLICK_ACCEPT_THRESHOLD',
      message: `L’acceptation par clic est réservée aux propositions de moins de ${settings.clickAcceptMaxCents / 100} € HT sur la durée : utilisez la signature électronique.`,
    });
  }
  const sectionBlocking: PendingValidation[] = sections
    .filter((s) => s.validationStatus === 'TO_VALIDATE' && !s.excluded)
    .map((s) => ({ scope: 'SECTION', key: s.key, label: s.title }));
  // Lot 9.9 : une section rédigée par IA part chez le client seulement après
  // relecture humaine explicite (brief §12.3, « validation humaine obligatoire »).
  const aiBlocking: PendingValidation[] = sections
    .filter((s) => s.aiPendingReview && !s.excluded)
    .map((s) => ({ scope: 'SECTION', key: s.key, label: s.title }));
  const blocking = [...quote.blockingValidations, ...sectionBlocking];
  for (const b of blocking) issues.push({ code: 'TO_VALIDATE', message: `« ${b.label} » est à valider (${b.scope}).` });
  for (const b of aiBlocking) {
    issues.push({ code: 'AI_PENDING', message: `Section « ${b.label} » générée par IA : à relire et valider avant envoi.`, sectionKey: b.key });
  }
  blocking.push(...aiBlocking);

  // Revue interne obligatoire (brief §12.2) : remise au-delà du seuil,
  // clause dérogatoire (contenu de bibliothèque ou de CGV modifié), montant.
  const reviewReasons: string[] = [];
  for (const r of definition.rules) {
    if (r.type === 'DISCOUNT_PERCENT' && r.percent > settings.reviewDiscountPercent && quote.lines.some((l) => l.key === r.key)) {
      reviewReasons.push(`Remise « ${r.label} » de ${r.percent} % (seuil ${settings.reviewDiscountPercent} %).`);
    }
  }
  for (const s of sections) {
    if (s.excluded || (s.kind !== 'LIBRARY' && s.kind !== 'TERMS')) continue;
    for (const b of s.blocks) {
      const c = b.content as { markdown?: string; sourceSha256?: string };
      if (b.type === 'RICH_TEXT' && c.sourceSha256 && sha(c.markdown ?? '') !== c.sourceSha256) {
        reviewReasons.push(`Contenu de référence modifié (clause dérogatoire) : « ${s.title} ».`);
      }
    }
  }
  if (settings.reviewAmountCents !== null && quote.commitment.htCents > BigInt(settings.reviewAmountCents)) {
    reviewReasons.push(`Montant sur la durée au-delà de ${settings.reviewAmountCents / 100} € HT.`);
  }

  const unresolved = issues.filter((i) => ['MERGE_TAG', 'UNKNOWN_TAG', 'TO_COMPLETE', 'MISSING_TERMS'].includes(i.code)).length;
  const counters: ReadinessCounters = {
    hasRecipients: recipients.length > 0,
    hasSigner: recipients.some((r: any) =>
      proposal.acceptanceMode === 'CLICK_ACCEPT' ? r.role !== 'READER' : r.role === 'SIGNER',
    ),
    unresolvedMergeTags: unresolved,
    blockingValidations: blocking.length,
    pricingErrors: quote.errors.length + issues.filter((i) => i.code === 'CLICK_ACCEPT_THRESHOLD').length,
    reviewRequired: reviewReasons.length > 0,
  };
  return { definition, selection, quote, mergeValues, issues, blocking, reviewReasons, counters, sections };
}
