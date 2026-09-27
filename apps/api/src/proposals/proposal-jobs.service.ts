import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import {
  findProposalFollowUpsDue,
  findProposalSignaturesNeedingProof,
  findProposalSignaturesNeedingSync,
  findProposalsToConvert,
  findProposalsToExpire,
  findProposalTrackingTenants,
  purgeProposalViewEvents,
  systemScope,
  tenantSystemScope,
  uuidv7,
  withScope,
} from '@lsi/persistence';
import { decideFollowUp, formatMergeValue, type EmailSender, type FollowUpKind } from '@lsi/domain';
import { bullConnection } from '../jobs/bullmq-job-queue.js';
import { EMAIL_SENDER } from '../notifications/email.token.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { DocusealWebhookService } from '../webhooks/docuseal-webhook.service.js';
import { newToken, publicLink } from './proposal-links.js';
import { ProposalConversionService } from './proposal-conversion.service.js';
import { PROPOSAL_QUEUE_NAME, type ProposalJobRef } from './proposal-jobs.port.js';
import { ProposalNotifier, type ProposalNotice } from './proposal-notifier.service.js';
import { ProposalSignatureService } from './proposal-signature.service.js';
import { parisDay, proposalSettingsFrom } from './proposal-state.js';
import { persistProposalTransition } from './proposal-transition.js';

const SWEEP_EVERY_MS = 5 * 60 * 1000;
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
const DAY = 86_400_000;

const FOLLOW_UP_SUBJECT: Record<FollowUpKind, string> = {
  NO_OPEN: 'Votre proposition vous attend',
  NO_DECISION: 'Avez-vous des questions sur notre proposition ?',
  BEFORE_EXPIRY: 'Votre proposition arrive bientôt à échéance',
};

/**
 * Traitements de fond des propositions (dans le `worker`, WORKER_ENABLED) :
 *   - `proposal-capture` / `proposal-convert` : preuves de signature puis
 *     conversion (enfilés par le webhook et l'acceptation) ;
 *   - `proposals-sweep` (5 min) : expiration, relances dues, filets de
 *     rattrapage (preuves, conversion, soumissions sans webhook) ;
 *   - `proposals-purge` (quotidien) : purge RGPD du suivi détaillé.
 * Chaque traitement est idempotent et s'exécute dans le scope du client
 * concerné, découvert par une fonction SECURITY DEFINER (identifiants seuls).
 */
@Injectable()
export class ProposalJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProposalJobsService.name);
  private worker?: Worker;
  private scheduler?: Queue;

  constructor(
    private readonly signature: ProposalSignatureService,
    private readonly conversion: ProposalConversionService,
    private readonly notifier: ProposalNotifier,
    private readonly config: TenantConfigService,
    private readonly docuseal: DocusealWebhookService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKER_ENABLED !== 'true') return;
    this.worker = new Worker(
      PROPOSAL_QUEUE_NAME,
      async (job) => {
        const now = new Date();
        switch (job.name) {
          case 'proposal-capture': {
            const d = job.data as ProposalJobRef & { signatureRequestId: string };
            await this.signature.capture(d.tenantId, d.customerId, d.signatureRequestId, now);
            return;
          }
          case 'proposal-convert': {
            const d = job.data as ProposalJobRef;
            await this.conversion.convert(d.tenantId, d.customerId, d.proposalId, now);
            return;
          }
          case 'proposals-sweep':
            await this.sweep(now);
            return;
          case 'proposals-purge':
            await this.purge(now);
            return;
          default:
            this.log.warn(`job de proposition inconnu : ${job.name}`);
        }
      },
      { connection: bullConnection(), concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => this.log.error(`job ${job?.name} #${job?.id} échoué : ${err.message}`));
    this.scheduler = new Queue(PROPOSAL_QUEUE_NAME, { connection: bullConnection() });
    await this.scheduler.add('proposals-sweep', {}, { repeat: { every: SWEEP_EVERY_MS }, jobId: 'proposals-sweep-5min', removeOnComplete: 50, removeOnFail: 200 });
    await this.scheduler.add('proposals-purge', {}, { repeat: { every: PURGE_EVERY_MS }, jobId: 'proposals-purge-daily', removeOnComplete: 20, removeOnFail: 50 });
    this.log.log('worker des propositions démarré (capture, conversion, balayage, purge)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.scheduler?.close();
  }

  /** Balayage : chaque étape est isolée (une erreur n'arrête pas les autres). */
  async sweep(now: Date): Promise<void> {
    for (const ref of await findProposalsToExpire()) await this.safe(`expiration ${ref.id}`, () => this.expire(ref.tenantId, ref.customerId, ref.id, now));
    for (const ref of await findProposalFollowUpsDue()) await this.safe(`relance ${ref.id}`, () => this.followUp(ref.tenantId, ref.customerId, ref.id, now));
    for (const ref of await findProposalSignaturesNeedingSync()) await this.safe(`synchro ${ref.id}`, () => this.docuseal.reconcileFromProvider(ref.providerSubmissionId));
    for (const ref of await findProposalSignaturesNeedingProof()) await this.safe(`preuves ${ref.id}`, () => this.signature.capture(ref.tenantId, ref.customerId, ref.id, now));
    for (const ref of await findProposalsToConvert()) await this.safe(`conversion ${ref.id}`, () => this.conversion.convert(ref.tenantId, ref.customerId, ref.id, now));
  }

  private async safe(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`${what} : ${(e as Error).message}`);
    }
  }

  /** Échéance passée : EXPIRÉE, relances annulées, commercial prévenu. */
  async expire(tenantId: string, customerId: string, proposalId: string, now: Date): Promise<void> {
    const notices: (ProposalNotice | null)[] = [];
    await withScope(systemScope(tenantId, customerId), async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id: proposalId }, include: { owner: { select: { email: true } } } });
      if (!p || !['SENT', 'VIEWED', 'IN_DISCUSSION'].includes(p.status)) return;
      await persistProposalTransition(tx, proposalId, { type: 'EXPIRE' }, { now });
      await tx.proposalFollowUp.updateMany({ where: { proposalId, status: 'PLANNED' }, data: { status: 'CANCELLED', skipReason: 'EXPIRATION', updatedAt: now } });
      notices.push(await this.notifier.record(tx, {
        tenantId, customerId, proposalId, recipientUserId: p.ownerUserId, recipientEmail: p.owner?.email ?? null,
        type: 'proposal.expired', subject: `${p.number} : proposition expirée`,
        body: `La proposition ${p.number} a expiré sans décision. Elle peut être réactivée avec une nouvelle date.`,
        dedupKey: `expired:${proposalId}:${p.expiresAt?.toISOString() ?? ''}`,
      }, now));
    });
    await this.notifier.flush(notices);
  }

  /**
   * Relance planifiée arrivée à échéance : la règle (suspendue si le client a
   * répondu, jamais plus d'une par 48 h, désactivable) est celle du domaine.
   * Une relance ENVOIE un nouveau lien personnel (l'ancien est révoqué : les
   * jetons ne sont jamais conservés en clair).
   */
  async followUp(tenantId: string, customerId: string, followUpId: string, now: Date): Promise<void> {
    const settings = proposalSettingsFrom(await this.config.settings(systemScope(tenantId, customerId)));
    const mails = await withScope(systemScope(tenantId, customerId), async (tx) => {
      const f = await tx.proposalFollowUp.findUnique({ where: { id: followUpId } });
      if (!f || f.status !== 'PLANNED') return [];
      const p = await tx.proposal.findUniqueOrThrow({ where: { id: f.proposalId }, include: { owner: true, customer: true } });
      const last = await tx.proposalFollowUp.findFirst({ where: { proposalId: p.id, status: 'SENT' }, orderBy: { sentAt: 'desc' } });
      const decision = decideFollowUp(f.kind, {
        status: p.status, enabled: p.followUpsEnabled, firstViewedAt: p.firstViewedAt, clientRespondedAt: p.clientRespondedAt,
        lastFollowUpSentAt: last?.sentAt ?? null, expiresAt: p.expiresAt,
      }, now);
      if (decision.action === 'SKIP') {
        await tx.proposalFollowUp.update({ where: { id: f.id }, data: { status: 'SKIPPED', skipReason: decision.reason, updatedAt: now } });
        return [];
      }
      if (decision.action === 'POSTPONE') {
        // Nouvelle échéance (même clé : proposition, type, date) — updateMany pour ne jamais lever dans la transaction.
        await tx.proposalFollowUp.updateMany({ where: { id: f.id }, data: { dueAt: decision.until, updatedAt: now } });
        return [];
      }
      const recipients = await tx.proposalRecipient.findMany({ where: { proposalId: p.id } });
      await tx.proposalAccessLink.updateMany({ where: { proposalId: p.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'RELANCE' } });
      const links = recipients.map((r: any) => ({ r, ...newToken() }));
      await tx.proposalAccessLink.createMany({
        data: links.map((l: any) => ({
          id: uuidv7(), tenantId, customerId, proposalId: p.id, versionId: p.currentVersionId as string, recipientId: l.r.id, tokenHash: l.hash,
          expiresAt: new Date((p.expiresAt ?? now).getTime() + settings.linkGraceDays * DAY), createdAt: now,
        })),
      });
      await tx.proposalFollowUp.update({ where: { id: f.id }, data: { status: 'SENT', sentAt: now, updatedAt: now } });
      const expiry = p.expiresAt ? formatMergeValue('proposition.dateExpiration', parisDay(p.expiresAt)) : null;
      return links.map((l: any) => ({
        recipientId: l.r.id, to: l.r.email, versionId: p.currentVersionId as string, proposalId: p.id as string,
        subject: `${FOLLOW_UP_SUBJECT[f.kind as FollowUpKind]} — ${p.number}`,
        text:
          `Bonjour ${l.r.fullName},\n\n${p.owner.fullName} se permet de revenir vers vous au sujet de la proposition ${p.number}` +
          `${expiry ? `, valable jusqu'au ${expiry}` : ''} :\n${publicLink(l.token)}\n\nCe lien vous est personnel.`,
        from: { fullName: p.owner.fullName, email: p.owner.email },
      }));
    });
    const rows: { m: (typeof mails)[number]; error: string | null }[] = [];
    for (const m of mails) {
      let error: string | null = null;
      try {
        await this.email.send({ to: m.to, subject: m.subject, text: m.text, fromName: `${m.from.fullName} — LSI Maintenance`, replyTo: m.from.email });
      } catch (e) {
        error = (e as Error).message.slice(0, 500);
      }
      rows.push({ m, error });
    }
    if (rows.length) {
      await withScope(systemScope(tenantId, customerId), (tx) =>
        tx.proposalDelivery.createMany({
          data: rows.map(({ m, error }) => ({
            id: uuidv7(), tenantId, customerId, proposalId: m.proposalId, versionId: m.versionId,
            recipientId: m.recipientId, kind: 'FOLLOW_UP' as const, subject: m.subject, sentByUserId: null, error, sentAt: now,
          })),
        }),
      );
    }
  }

  /** Purge RGPD : suivi DÉTAILLÉ des propositions décidées / expirées au-delà de la conservation du tenant. */
  async purge(now: Date): Promise<number> {
    let total = 0;
    for (const tenantId of await findProposalTrackingTenants()) {
      const scope = tenantSystemScope(tenantId);
      const days = (await this.config.setting(scope, 'proposals.trackingRetentionDays')) as number;
      total += await withScope(scope, (tx) => purgeProposalViewEvents(tx, tenantId, days));
    }
    if (total) this.log.log(`suivi de lecture purgé : ${total} événement(s) (${now.toISOString()})`);
    return total;
  }
}
