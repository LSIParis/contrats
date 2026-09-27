import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  proposalLinkScope,
  resolveProposalLink,
  systemScope,
  uuidv7,
  withScope,
  type ResolvedProposalLink,
  type Scope,
} from '@lsi/persistence';
import { PROPOSAL_STATUS_LABELS, truncateIp, type EmailSender } from '@lsi/domain';
import { quoteProposal, toJsonSafe, type ProposalPricingDefinition, type ProposalQuote } from '@lsi/pricing';
import { EMAIL_SENDER } from '../notifications/email.token.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { pricingContextOf, renderSections, sha256Hex, stableStringify, type SectionWithBlocks } from './proposal-content.js';
import {
  hashToken,
  newOtp,
  newToken,
  otpHash,
  OTP_MAX_ATTEMPTS,
  OTP_SESSION_TTL_MS,
  OTP_TTL_MS,
  sameHash,
  TOKEN_RE,
} from './proposal-links.js';
import { ProposalNotifier, type ProposalNotice } from './proposal-notifier.service.js';
import { parisDay, proposalSettingsFrom, selectionOf, type SelectionInput } from './proposal-state.js';
import { persistProposalTransition } from './proposal-transition.js';
import { publicDefinitionView, quoteView } from './proposal-views.js';
import { ProposalDocumentsService } from './proposal-documents.service.js';
import { PROPOSAL_JOB_QUEUE, type ProposalJobQueue } from './proposal-jobs.port.js';
import { ProposalSignatureService } from './proposal-signature.service.js';
import { cancelFollowUps } from './proposals.service.js';
import type { AcceptBody, SelectionBody, ViewEventsBody } from './proposals.schemas.js';

/** Statuts où la page est « ouverte » : consultation, configuration, questions, décision. */
const OPEN = ['SENT', 'VIEWED', 'IN_DISCUSSION'];
const RETURN_AFTER_MS = 3 * 86_400_000;
const TRACKING_NOTICE =
  'Pour le suivi de cette proposition, LSI-Maintenance enregistre les ouvertures, le temps passé par section et les ' +
  'téléchargements (adresse IP tronquée, aucun traceur tiers). Ces informations servent uniquement au suivi commercial ' +
  'et sont purgées après votre décision.';

interface LinkContext {
  readonly link: ResolvedProposalLink;
  /** Scope de LECTURE confiné à la proposition (politiques *_link_read). */
  readonly read: Scope;
  /** Scope d'écriture : système, limité au client du lien — jamais au-delà. */
  readonly write: Scope;
}

/**
 * Page publique d'une proposition (`/p/<jeton>`, brief §12.5-12.6).
 *
 * Aucune session : le jeton (256 bits, haché en base) est résolu par une
 * fonction SECURITY DEFINER qui ne renvoie que des identifiants. Les
 * LECTURES se font dans un scope confiné en base à la proposition du lien ;
 * les ÉCRITURES (suivi, configuration, questions, décision) dans le scope
 * système du SEUL client du lien, toujours filtrées par l'identifiant de la
 * proposition résolue — jamais par une valeur fournie par le navigateur.
 */
@Injectable()
export class ProposalPublicService {
  private readonly log = new Logger(ProposalPublicService.name);

  constructor(
    private readonly config: TenantConfigService,
    private readonly notifier: ProposalNotifier,
    private readonly docs: ProposalDocumentsService,
    private readonly signature: ProposalSignatureService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(PROPOSAL_JOB_QUEUE) private readonly jobs: ProposalJobQueue,
  ) {}

  // -------------------------------------------------------------------------
  // Résolution du lien
  // -------------------------------------------------------------------------

  async resolve(token: string, now: Date): Promise<LinkContext> {
    // Forme stricte : une chaîne arbitraire n'est même pas hachée.
    if (!TOKEN_RE.test(token)) throw new NotFoundException('Lien introuvable');
    const link = await resolveProposalLink(hashToken(token));
    if (!link) throw new NotFoundException('Lien introuvable');
    if (link.revokedAt) throw new GoneException({ code: 'LINK_REVOKED', detail: 'Ce lien n’est plus valable : une version plus récente vous a été (ou vous sera) adressée.' });
    if (link.expiresAt <= now) throw new GoneException({ code: 'LINK_EXPIRED', detail: 'Ce lien a expiré.' });
    const read = proposalLinkScope(link.tenantId, link.proposalId);
    if (!(await this.config.isEnabled(read, 'contrats.proposals.enabled'))) throw new NotFoundException('Lien introuvable');
    return { link, read, write: systemScope(link.tenantId, link.customerId) };
  }

  /** Session « code vérifié » (propositions sensibles, acceptation par clic). */
  private async otpVerified(ctx: LinkContext, otpSession: string | undefined, now: Date): Promise<boolean> {
    if (!otpSession) return false;
    const row = await withScope(ctx.write, (tx) =>
      tx.proposalAccessLink.findUnique({ where: { id: ctx.link.linkId }, select: { otpSessionHash: true, otpSessionExpiresAt: true } }),
    );
    return !!row?.otpSessionExpiresAt && row.otpSessionExpiresAt > now && sameHash(row.otpSessionHash, hashToken(otpSession));
  }

  private async loadForLink(ctx: LinkContext) {
    return withScope(ctx.read, async (tx) => {
      const proposal = await tx.proposal.findUnique({
        where: { id: ctx.link.proposalId },
        select: {
          id: true, number: true, title: true, status: true, expiresAt: true, acceptanceMode: true, sensitive: true,
          currentVersionId: true, mergeContext: true, ownerUserId: true,
        },
      });
      const version = await tx.proposalVersion.findUnique({
        where: { id: ctx.link.versionId },
        include: { sections: { orderBy: { position: 'asc' }, include: { blocks: { orderBy: { position: 'asc' } } } } },
      });
      if (!proposal || !version) throw new NotFoundException('Lien introuvable');
      const recipient = await tx.proposalRecipient.findUnique({ where: { id: ctx.link.recipientId }, select: { id: true, fullName: true, role: true, email: true } });
      if (!recipient) throw new NotFoundException('Lien introuvable');
      const latestSelection = await tx.proposalSelection.findFirst({ where: { versionId: version.id }, orderBy: { createdAt: 'desc' } });
      const comments = await tx.proposalComment.findMany({
        where: { proposalId: proposal.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, parentId: true, sectionKey: true, authorKind: true, authorName: true, body: true, createdAt: true },
      });
      const signer = await tx.proposalSigner.findFirst({
        where: { proposalId: proposal.id, recipientId: recipient.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, embedSrc: true },
      });
      return { proposal, version, recipient, latestSelection, comments, signer };
    });
  }

  private quote(version: { pricingDefinition: unknown; pricingSettings: unknown }, selection: SelectionInput, mergeContext: unknown, now: Date): ProposalQuote {
    return quoteProposal(
      version.pricingDefinition as unknown as ProposalPricingDefinition,
      { ...selection, context: pricingContextOf((mergeContext ?? {}) as Record<string, unknown>) },
      { date: parisDay(now), settings: (version.pricingSettings ?? {}) as object },
    );
  }

  private isOpen(p: { status: string; expiresAt: Date | null }, v: { supersededAt: Date | null; id: string }, current: string | null, now: Date) {
    return OPEN.includes(p.status) && (!p.expiresAt || p.expiresAt > now) && !v.supersededAt && v.id === current;
  }

  // -------------------------------------------------------------------------
  // Consultation
  // -------------------------------------------------------------------------

  async view(token: string, otpSession: string | undefined, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { proposal, version, recipient } = d;
    const verified = await this.otpVerified(ctx, otpSession, now);
    const locked = proposal.sensitive && !verified;
    const expired = proposal.status === 'EXPIRED' || (!!proposal.expiresAt && proposal.expiresAt <= now);
    const open = this.isOpen(proposal, version, proposal.currentVersionId, now);
    const decider = recipient.role !== 'READER';
    const base = {
      proposal: {
        number: proposal.number,
        title: version.title,
        status: proposal.status,
        statusLabel: PROPOSAL_STATUS_LABELS[proposal.status as keyof typeof PROPOSAL_STATUS_LABELS],
        expiresAt: proposal.expiresAt,
        acceptanceMode: proposal.acceptanceMode,
        sensitive: proposal.sensitive,
        versionNumber: version.versionNumber,
      },
      recipient: { fullName: recipient.fullName, role: recipient.role },
      expired,
      superseded: !!version.supersededAt,
      trackingNotice: TRACKING_NOTICE,
      otp: { required: proposal.sensitive, verified },
    };
    if (locked) return { ...base, content: null, comments: [], actions: null, signature: null };

    const terms = version.termsId
      ? await withScope(ctx.write, (tx) => tx.proposalTerms.findUnique({ where: { id: version.termsId! }, select: { title: true, body: true } }))
      : null;
    const sections: SectionWithBlocks[] = version.sections.map((s) => ({ ...s, blocks: s.blocks }));
    const selection = selectionOf(d.latestSelection);
    const quote = this.quote(version, selection, proposal.mergeContext, now);
    return {
      ...base,
      content: {
        sections: renderSections(sections, version.mergeValues as Record<string, string | number>, terms),
        pricing: {
          definition: publicDefinitionView(version.pricingDefinition as unknown as ProposalPricingDefinition),
          selection,
          quote: quoteView(quote),
        },
      },
      comments: d.comments,
      actions: {
        canConfigure: open,
        canComment: open || proposal.status === 'ACCEPTED',
        canDecline: open && decider,
        canAccept: open && decider && quote.errors.length === 0,
        acceptRequiresOtp: proposal.acceptanceMode === 'CLICK_ACCEPT',
      },
      signature: d.signer ? { status: d.signer.status, embedSrc: proposal.status === 'PENDING_SIGNATURE' ? d.signer.embedSrc : null } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Suivi de lecture (balise d'envoi groupée)
  // -------------------------------------------------------------------------

  async track(token: string, body: ViewEventsBody, ip: string | undefined, userAgent: string | undefined, now: Date) {
    const ctx = await this.resolve(token, now);
    const { link } = ctx;
    const notices: (ProposalNotice | null)[] = [];
    await withScope(ctx.write, async (tx) => {
      const p = await tx.proposal.findUnique({
        where: { id: link.proposalId },
        include: { owner: { select: { id: true, email: true } } },
      });
      if (!p) throw new NotFoundException('Lien introuvable');
      const linkRow = await tx.proposalAccessLink.findUnique({ where: { id: link.linkId } });
      if (!linkRow) throw new NotFoundException('Lien introuvable');
      const ipTruncated = truncateIp(ip);
      const ua = userAgent ? userAgent.slice(0, 200) : null;
      const events: { kind: 'OPENED' | 'SECTION_VIEWED' | 'PDF_DOWNLOADED' | 'NEW_VIEWER'; sectionKey: string | null; durationMs: number | null }[] =
        body.events.map((e) => ({ kind: e.type, sectionKey: e.sectionKey ?? null, durationMs: e.durationMs ?? null }));

      // Lien transféré : un navigateur jamais vu sur ce lien (empreinte pseudonyme, bornée).
      if (body.viewerId) {
        const viewer = sha256Hex(`${link.linkId}:${body.viewerId}`);
        const known = linkRow.knownViewers ?? [];
        if (!known.includes(viewer)) {
          if (known.length > 0) {
            events.push({ kind: 'NEW_VIEWER', sectionKey: null, durationMs: null });
            notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.new_viewer', `${p.number} : consultation par un nouveau lecteur`,
              `La proposition ${p.number} vient d'être ouverte depuis un navigateur inconnu (lien transféré ?).`, `new-viewer:${p.id}:${viewer}`), now));
          }
          if (known.length < 20) {
            await tx.proposalAccessLink.update({ where: { id: link.linkId }, data: { knownViewers: [...known, viewer] } });
          }
        }
      }

      await tx.proposalViewEvent.createMany({
        data: events.map((e) => ({
          id: uuidv7(), tenantId: link.tenantId, customerId: link.customerId, proposalId: link.proposalId, versionId: link.versionId,
          recipientId: link.recipientId, linkId: link.linkId, kind: e.kind, sectionKey: e.sectionKey, durationMs: e.durationMs,
          ipTruncated, userAgent: ua, occurredAt: now,
        })),
      });
      await this.bumpStats(tx, link, events, now);
      await tx.proposalAccessLink.update({ where: { id: link.linkId }, data: { lastUsedAt: now, firstUsedAt: linkRow.firstUsedAt ?? now } });

      const opened = events.some((e) => e.kind === 'OPENED');
      if (opened && p.status === 'SENT') {
        await persistProposalTransition(tx, p.id, { type: 'VIEW' }, { now });
        notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.first_open', `${p.number} : première ouverture`,
          `La proposition ${p.number} vient d'être ouverte pour la première fois.`, `first-open:${p.id}`), now));
      } else if (opened && p.lastActivityAt && now.getTime() - p.lastActivityAt.getTime() > RETURN_AFTER_MS) {
        notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.returned', `${p.number} : retour du client`,
          `Le client revient sur la proposition ${p.number} après plusieurs jours.`, `returned:${p.id}:${parisDay(now)}`), now));
      }
      await tx.proposal.update({
        where: { id: p.id },
        data: { lastActivityAt: now, ...(opened && !p.firstViewedAt ? { firstViewedAt: now } : {}) },
      });
    });
    await this.notifier.flush(notices);
    return { recorded: body.events.length };
  }

  private async bumpStats(
    tx: any,
    link: ResolvedProposalLink,
    events: readonly { kind: string; sectionKey: string | null; durationMs: number | null }[],
    now: Date,
  ) {
    const agg = new Map<string, { opens: number; ms: number; pdf: number; viewers: number }>();
    const add = (key: string, f: (a: { opens: number; ms: number; pdf: number; viewers: number }) => void) => {
      const a = agg.get(key) ?? { opens: 0, ms: 0, pdf: 0, viewers: 0 };
      f(a);
      agg.set(key, a);
    };
    for (const e of events) {
      if (e.kind === 'OPENED') add('', (a) => (a.opens += 1));
      if (e.kind === 'PDF_DOWNLOADED') add('', (a) => (a.pdf += 1));
      if (e.kind === 'NEW_VIEWER') add('', (a) => (a.viewers += 1));
      if (e.kind === 'SECTION_VIEWED' && e.sectionKey) {
        add(e.sectionKey, (a) => (a.ms += e.durationMs ?? 0));
        add('', (a) => (a.ms += e.durationMs ?? 0));
      }
    }
    for (const [sectionKey, a] of agg) {
      // Incrément ATOMIQUE (ON CONFLICT) : jamais de reprise d'erreur dans la transaction.
      await tx.$executeRaw`
        INSERT INTO proposal_view_stats (tenant_id, customer_id, proposal_id, section_key, opens, total_duration_ms, pdf_downloads, new_viewers, last_viewed_at)
        VALUES (${link.tenantId}::uuid, ${link.customerId}::uuid, ${link.proposalId}::uuid, ${sectionKey}, ${a.opens}::int, ${a.ms}::bigint,
                ${a.pdf}::int, ${a.viewers}::int, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3))
        ON CONFLICT (proposal_id, section_key) DO UPDATE SET
          opens = proposal_view_stats.opens + EXCLUDED.opens,
          total_duration_ms = proposal_view_stats.total_duration_ms + EXCLUDED.total_duration_ms,
          pdf_downloads = proposal_view_stats.pdf_downloads + EXCLUDED.pdf_downloads,
          new_viewers = proposal_view_stats.new_viewers + EXCLUDED.new_viewers,
          last_viewed_at = EXCLUDED.last_viewed_at`;
    }
  }

  private notice(p: any, type: ProposalNotice['type'], subject: string, body: string, dedupKey: string): ProposalNotice {
    return {
      tenantId: p.tenantId, customerId: p.customerId, proposalId: p.id, recipientUserId: p.ownerUserId,
      recipientEmail: p.owner?.email ?? null, type, subject, body, dedupKey,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration du tableau de prix (recalculée par le moteur, côté serveur)
  // -------------------------------------------------------------------------

  async select(token: string, otpSession: string | undefined, body: SelectionBody, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { proposal, version, recipient } = d;
    if (proposal.sensitive && !(await this.otpVerified(ctx, otpSession, now))) throw new ForbiddenException({ code: 'OTP_REQUIRED' });
    if (!this.isOpen(proposal, version, proposal.currentVersionId, now)) {
      throw new ConflictException({ code: 'PROPOSAL_CLOSED', detail: 'Cette proposition ne peut plus être modifiée.' });
    }
    const def = version.pricingDefinition as unknown as ProposalPricingDefinition;
    // Seuls les éléments ouverts au client : le navigateur peut forger n'importe quoi.
    for (const k of Object.keys(body.choices ?? {})) {
      if (!def.choices.find((c) => c.key === k)?.editableByClient) throw new BadRequestException(`Choix non modifiable : ${k}`);
    }
    for (const k of Object.keys(body.quantities ?? {})) {
      if (!def.lines.find((l) => l.key === k)?.quantity?.editableByClient) throw new BadRequestException(`Quantité non modifiable : ${k}`);
    }
    for (const k of body.selectedOptions ?? []) {
      if (def.lines.find((l) => l.key === k)?.kind !== 'OPTIONAL') throw new BadRequestException(`Option inconnue : ${k}`);
    }
    const prev = selectionOf(d.latestSelection);
    const selection: SelectionInput = {
      choices: { ...prev.choices, ...(body.choices ?? {}) },
      quantities: { ...prev.quantities, ...(body.quantities ?? {}) },
      selectedOptions: body.selectedOptions ?? prev.selectedOptions,
    };
    const quote = this.quote(version, selection, proposal.mergeContext, now);
    const notices: (ProposalNotice | null)[] = [];
    await withScope(ctx.write, async (tx) => {
      const q = quote;
      await tx.proposalSelection.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: proposal.id, versionId: version.id,
          choices: selection.choices, quantities: selection.quantities, selectedOptions: selection.selectedOptions,
          oneTimeCents: q.oneTime.htCents, monthlyCents: q.monthly.htCents, quarterlyCents: q.quarterly.htCents, yearlyCents: q.yearly.htCents,
          commitmentTotalCents: q.commitment.htCents, commitmentMonths: q.commitmentMonths, errors: [...q.errors],
          actorKind: 'CLIENT', recipientId: recipient.id, userId: null, createdAt: now,
        },
      });
      const p = await tx.proposal.update({
        where: { id: proposal.id },
        data: {
          oneTimeCents: q.oneTime.htCents, monthlyCents: q.monthly.htCents, commitmentTotalCents: q.commitment.htCents,
          commitmentMonths: q.commitmentMonths, lastActivityAt: now,
        },
        include: { owner: { select: { email: true } } },
      });
      // « Option modifiée », au plus une notification par quart d'heure.
      const slot = Math.floor(now.getTime() / 900_000);
      notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.option_changed', `${p.number} : configuration modifiée par le client`,
        `${recipient.fullName} a modifié la configuration de la proposition ${p.number}.`, `option:${p.id}:${slot}`), now));
    });
    await this.notifier.flush(notices);
    return { selection, quote: quoteView(quote) };
  }

  // -------------------------------------------------------------------------
  // Questions, refus
  // -------------------------------------------------------------------------

  async comment(token: string, otpSession: string | undefined, body: { body: string; sectionKey?: string | undefined }, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { proposal, version, recipient } = d;
    if (proposal.sensitive && !(await this.otpVerified(ctx, otpSession, now))) throw new ForbiddenException({ code: 'OTP_REQUIRED' });
    if (!this.isOpen(proposal, version, proposal.currentVersionId, now) && proposal.status !== 'ACCEPTED') {
      throw new ConflictException({ code: 'PROPOSAL_CLOSED', detail: 'Cette proposition n’accepte plus de questions.' });
    }
    if (body.sectionKey && !version.sections.some((s) => s.key === body.sectionKey)) throw new BadRequestException('Section inconnue');
    const notices: (ProposalNotice | null)[] = [];
    const row = await withScope(ctx.write, async (tx) => {
      const c = await tx.proposalComment.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: proposal.id, versionId: version.id,
          sectionKey: body.sectionKey ?? null, authorKind: 'CLIENT', recipientId: recipient.id, authorName: recipient.fullName,
          body: body.body, createdAt: now,
        },
        select: { id: true, sectionKey: true, authorKind: true, authorName: true, body: true, createdAt: true },
      });
      const p = await tx.proposal.findUniqueOrThrow({ where: { id: proposal.id }, include: { owner: { select: { email: true } } } });
      if (p.status === 'SENT') await persistProposalTransition(tx, p.id, { type: 'VIEW' }, { now });
      if (p.status === 'SENT' || p.status === 'VIEWED') await persistProposalTransition(tx, p.id, { type: 'OPEN_DISCUSSION' }, { now });
      await tx.proposal.update({ where: { id: p.id }, data: { clientRespondedAt: now, lastActivityAt: now } });
      notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.question', `${p.number} : question du client`,
        `${recipient.fullName} a posé une question${body.sectionKey ? ` (section ${body.sectionKey})` : ''} :\n\n${body.body}`, `question:${c.id}`), now));
      return c;
    });
    await this.notifier.flush(notices);
    return row;
  }

  async decline(token: string, otpSession: string | undefined, body: { reasonCode: string; reason?: string | undefined }, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { proposal, recipient } = d;
    if (proposal.sensitive && !(await this.otpVerified(ctx, otpSession, now))) throw new ForbiddenException({ code: 'OTP_REQUIRED' });
    if (recipient.role === 'READER') throw new ForbiddenException({ code: 'READER', detail: 'Un lecteur ne décide pas de la proposition.' });
    const notices: (ProposalNotice | null)[] = [];
    await withScope(ctx.write, async (tx) => {
      const p = await tx.proposal.findUniqueOrThrow({ where: { id: proposal.id }, include: { owner: { select: { email: true } } } });
      await persistProposalTransition(tx, p.id, { type: 'DECLINE', reasonCode: body.reasonCode, reason: body.reason ?? '' }, {
        now,
        extra: { declineReasonCode: body.reasonCode, declineReason: body.reason ?? null, clientRespondedAt: now, lastActivityAt: now },
      });
      await cancelFollowUps(tx, p.id, now, 'REFUS');
      notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.declined', `${p.number} : proposition refusée`,
        `${recipient.fullName} a refusé la proposition ${p.number} (motif : ${body.reasonCode}${body.reason ? ` — ${body.reason}` : ''}).`, `declined:${p.id}`), now));
    });
    await this.notifier.flush(notices);
    return { status: 'DECLINED' };
  }

  // -------------------------------------------------------------------------
  // Code à usage unique
  // -------------------------------------------------------------------------

  async requestOtp(token: string, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { code, hash } = newOtp(ctx.link.linkId);
    await withScope(ctx.write, async (tx) => {
      await tx.proposalAccessLink.update({
        where: { id: ctx.link.linkId },
        data: { otpHash: hash, otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS), otpAttempts: 0 },
      });
      await tx.proposalDelivery.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: d.proposal.id, versionId: d.version.id,
          recipientId: d.recipient.id, kind: 'OTP', subject: `Code d’accès — proposition ${d.proposal.number}`, sentAt: now,
        },
      });
    });
    try {
      await this.email.send({
        to: d.recipient.email,
        subject: `Code d’accès — proposition ${d.proposal.number}`,
        text: `Bonjour ${d.recipient.fullName},\n\nVotre code à usage unique : ${code}\nIl est valable 10 minutes.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
      });
    } catch (e) {
      this.log.warn(`code à usage unique non envoyé : ${(e as Error).message}`);
    }
    // Adresse masquée : on confirme la destination sans la révéler.
    return { sentTo: d.recipient.email.replace(/^(.).*(@.*)$/, '$1•••$2') };
  }

  async verifyOtp(token: string, code: string, now: Date) {
    const ctx = await this.resolve(token, now);
    return withScope(ctx.write, async (tx) => {
      const row = await tx.proposalAccessLink.findUnique({ where: { id: ctx.link.linkId } });
      if (!row?.otpHash || !row.otpExpiresAt || row.otpExpiresAt <= now) throw new ForbiddenException({ code: 'OTP_EXPIRED', detail: 'Code expiré : demandez-en un nouveau.' });
      if (row.otpAttempts >= OTP_MAX_ATTEMPTS) throw new ForbiddenException({ code: 'OTP_LOCKED', detail: 'Trop d’essais : demandez un nouveau code.' });
      if (!sameHash(row.otpHash, otpHash(row.id, code))) {
        await tx.proposalAccessLink.update({ where: { id: row.id }, data: { otpAttempts: { increment: 1 } } });
        throw new ForbiddenException({ code: 'OTP_INVALID', detail: 'Code incorrect.' });
      }
      const session = newToken();
      await tx.proposalAccessLink.update({
        where: { id: row.id },
        data: {
          otpHash: null, otpExpiresAt: null, otpAttempts: 0, otpVerifiedAt: now,
          otpSessionHash: session.hash, otpSessionExpiresAt: new Date(now.getTime() + OTP_SESSION_TTL_MS),
        },
      });
      return { otpSession: session.token, expiresInSeconds: OTP_SESSION_TTL_MS / 1000 };
    });
  }

  // -------------------------------------------------------------------------
  // Acceptation (clic ou signature DocuSeal)
  // -------------------------------------------------------------------------

  async accept(token: string, otpSession: string | undefined, body: AcceptBody, ip: string | undefined, userAgent: string | undefined, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    const { proposal, version, recipient } = d;
    if (recipient.role === 'READER') throw new ForbiddenException({ code: 'READER', detail: 'Un lecteur ne peut pas accepter la proposition.' });
    const verified = await this.otpVerified(ctx, otpSession, now);
    if ((proposal.sensitive || proposal.acceptanceMode === 'CLICK_ACCEPT') && !verified) {
      throw new ForbiddenException({ code: 'OTP_REQUIRED', detail: 'Vérifiez votre adresse e-mail avec le code reçu avant d’accepter.' });
    }
    if (proposal.acceptanceMode === 'DOCUSEAL_SIGNATURE' && recipient.role !== 'SIGNER') {
      throw new ForbiddenException({ code: 'NOT_SIGNER', detail: 'Seul un signataire désigné peut accepter et signer.' });
    }
    // Version remplacée ou échue : refus explicite AVANT tout calcul (la machine le revérifie).
    if (version.supersededAt || version.id !== proposal.currentVersionId) {
      throw new ConflictException({ code: 'PROPOSAL_RULE_VIOLATION', rule: 'P-SUPERSEDED', detail: 'Cette version a été remplacée : elle ne peut plus être acceptée.' });
    }
    const selection = selectionOf(d.latestSelection);
    const quote = this.quote(version, selection, proposal.mergeContext, now);
    if (quote.errors.length || !quote.engineSchedule || !quote.engineResult) {
      throw new ConflictException({ code: 'PRICING_INVALID', detail: 'La configuration du tableau de prix est incomplète.', errors: quote.errors });
    }

    const notices: (ProposalNotice | null)[] = [];
    const result = await withScope(ctx.write, async (tx) => {
      // La configuration acceptée est ENREGISTRÉE puis FIGÉE (PricingSnapshot).
      const sel = await tx.proposalSelection.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: proposal.id, versionId: version.id,
          choices: selection.choices, quantities: selection.quantities, selectedOptions: selection.selectedOptions,
          oneTimeCents: quote.oneTime.htCents, monthlyCents: quote.monthly.htCents, quarterlyCents: quote.quarterly.htCents,
          yearlyCents: quote.yearly.htCents, commitmentTotalCents: quote.commitment.htCents, commitmentMonths: quote.commitmentMonths,
          errors: [], actorKind: 'CLIENT', recipientId: recipient.id, userId: null, createdAt: now,
        },
      });
      const frozen = {
        definition: version.pricingDefinition,
        selection: { ...selection, quantities: quote.quantities, choices: quote.choices },
        engineSchedule: quote.engineSchedule,
        engineResult: toJsonSafe(quote.engineResult),
      };
      const snapshotId = uuidv7();
      await tx.pricingSnapshot.create({
        data: {
          id: snapshotId, tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: proposal.id, versionId: version.id,
          selectionId: sel.id, definition: frozen.definition as object, selection: frozen.selection as object,
          engineSchedule: frozen.engineSchedule as object, engineResult: frozen.engineResult as object,
          oneTimeCents: quote.oneTime.htCents, monthlyCents: quote.monthly.htCents, commitmentTotalCents: quote.commitment.htCents,
          commitmentMonths: quote.commitmentMonths, sha256: sha256Hex(stableStringify(frozen)), createdAt: now,
        },
      });
      await tx.proposalAcceptance.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: proposal.id, versionId: version.id,
          snapshotId, recipientId: recipient.id, mode: proposal.acceptanceMode, acceptedByName: body.fullName,
          acceptedByFunction: body.jobTitle, acceptedByEmail: body.email, emailVerifiedAt: verified ? now : null,
          ip: ip ?? null, userAgent: userAgent ? userAgent.slice(0, 300) : null, versionPdfSha256: version.pdfSha256, acceptedAt: now,
        },
      });
      const p = await tx.proposal.findUniqueOrThrow({ where: { id: proposal.id }, include: { owner: { select: { email: true } } } });
      if (p.status === 'SENT') await persistProposalTransition(tx, p.id, { type: 'VIEW' }, { now });
      await persistProposalTransition(tx, p.id, { type: 'ACCEPT', versionId: version.id }, {
        now,
        extra: {
          acceptedSnapshotId: snapshotId, clientRespondedAt: now, lastActivityAt: now,
          oneTimeCents: quote.oneTime.htCents, monthlyCents: quote.monthly.htCents,
          commitmentTotalCents: quote.commitment.htCents, commitmentMonths: quote.commitmentMonths,
        },
      });
      await cancelFollowUps(tx, p.id, now, 'ACCEPTATION');
      notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.accepted', `${p.number} : proposition acceptée`,
        `${body.fullName} (${body.jobTitle}) a accepté la proposition ${p.number}.`, `accepted:${p.id}:${snapshotId}`), now));
      if (p.acceptanceMode === 'CLICK_ACCEPT') {
        // Acceptation par clic : la trace d'acceptation EST la preuve (V2-H43).
        await persistProposalTransition(tx, p.id, { type: 'COMPLETE_CLICK_ACCEPT' }, { now });
        await tx.customer.updateMany({ where: { id: p.customerId, commercialStatus: 'PROSPECT' }, data: { commercialStatus: 'CLIENT', updatedAt: now } });
        notices.push(await this.notifier.record(tx, this.notice(p, 'proposal.signed', `${p.number} : proposition signée`,
          `La proposition ${p.number} est acceptée par clic : le contrat va être généré.`, `signed:${p.id}`), now));
      }
      return { mode: p.acceptanceMode, snapshotId };
    });
    await this.notifier.flush(notices);

    if (result.mode === 'CLICK_ACCEPT') {
      await this.jobs.enqueueConvert({ proposalId: proposal.id, tenantId: ctx.link.tenantId, customerId: ctx.link.customerId }).catch((e: Error) =>
        this.log.warn(`conversion non enfilée (rattrapée par le balayage) : ${e.message}`),
      );
      return { status: 'SIGNED', signature: null };
    }
    // Signature DocuSeal intégrée ; si DocuSeal est indisponible, la proposition reste ACCEPTÉE
    // et le commercial relance l'envoi en signature (rien n'est perdu).
    try {
      const s = await this.signature.start(ctx.write, proposal.id, recipient.id, now);
      return { status: 'PENDING_SIGNATURE', signature: s };
    } catch (e) {
      this.log.warn(`signature non démarrée pour ${proposal.number} : ${(e as Error).message}`);
      return { status: 'ACCEPTED', signature: null, signatureError: (e as { response?: { code?: string } }).response?.code ?? 'SIGNATURE_UNAVAILABLE' };
    }
  }

  /** PDF de la version (identique au contenu envoyé), téléchargement tracé. */
  async pdf(token: string, otpSession: string | undefined, now: Date) {
    const ctx = await this.resolve(token, now);
    const d = await this.loadForLink(ctx);
    if (d.proposal.sensitive && !(await this.otpVerified(ctx, otpSession, now))) throw new ForbiddenException({ code: 'OTP_REQUIRED' });
    const settings = proposalSettingsFrom(await this.config.settings(ctx.write));
    const file = await this.docs.versionPdf(ctx.write, d.proposal.id, settings, now, d.version.id);
    await withScope(ctx.write, async (tx) => {
      await tx.proposalViewEvent.create({
        data: {
          id: uuidv7(), tenantId: ctx.link.tenantId, customerId: ctx.link.customerId, proposalId: d.proposal.id, versionId: d.version.id,
          recipientId: d.recipient.id, linkId: ctx.link.linkId, kind: 'PDF_DOWNLOADED', occurredAt: now,
        },
      });
      await this.bumpStats(tx, ctx.link, [{ kind: 'PDF_DOWNLOADED', sectionKey: null, durationMs: null }], now);
    });
    return file;
  }
}
