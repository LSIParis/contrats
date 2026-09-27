import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { resolveProposalWebhookScope, systemScope, uuidv7, withScope, type Scope } from '@lsi/persistence';
import {
  linkDocumentHashes,
  ProviderError,
  type ESignatureProvider,
  type NormalizedSignatureEvent,
  type SubmitterCommand,
} from '@lsi/domain';
import type { ProposalPricingDefinition, ProposalQuote } from '@lsi/pricing';
import { quoteProposal } from '@lsi/pricing';
import { ESIGNATURE_PROVIDER } from '../signature/provider.token.js';
import { SignatureAvailabilityService } from '../signature/signature-availability.service.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { pricingContextOf, sha256Hex } from './proposal-content.js';
import { ProposalDocumentsService, type SignerForPdf } from './proposal-documents.service.js';
import { PROPOSAL_JOB_QUEUE, type ProposalJobQueue } from './proposal-jobs.port.js';
import { ProposalNotifier, type ProposalNotice } from './proposal-notifier.service.js';
import { parisDay, proposalSettingsFrom } from './proposal-state.js';
import { persistProposalTransition } from './proposal-transition.js';

const CLOSED = new Set(['REVOKED', 'DECLINED', 'EXPIRED', 'COMPLETED', 'FAILED']);

export type ProposalWebhookOutcome = 'processed' | 'duplicate_ignored' | 'unknown_submission' | 'closed_ignored' | 'rejected';

/**
 * Signature DocuSeal d'une proposition acceptée (brief §12.6).
 *
 * RÉUTILISE l'adaptateur des contrats (`ESIGNATURE_PROVIDER`, voie nominale
 * POST /submissions/pdf, balises textuelles) et son pipeline de webhooks :
 * `DocusealWebhookService` délègue ici les soumissions qu'il ne trouve pas
 * parmi celles des contrats. Mêmes règles : scope résolu depuis NOTRE base,
 * idempotence par contrainte UNIQUE, effets monotones (tolérance au désordre).
 *
 * Ordre du brief (§12.6, 4) : à la complétion, les preuves (PDF signé, journal
 * d'audit) sont rapatriées et ARCHIVÉES localement, PUIS la proposition passe
 * SIGNÉE — et la conversion en contrat est enfilée.
 */
@Injectable()
export class ProposalSignatureService {
  private readonly log = new Logger(ProposalSignatureService.name);

  constructor(
    @Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider,
    private readonly availability: SignatureAvailabilityService,
    private readonly config: TenantConfigService,
    private readonly docs: ProposalDocumentsService,
    private readonly notifier: ProposalNotifier,
    @Inject(PROPOSAL_JOB_QUEUE) private readonly jobs: ProposalJobQueue,
  ) {}

  /**
   * Démarre la signature d'une proposition ACCEPTÉE : PDF final (options
   * retenues, CGV, zone de signature) haché AVANT l'envoi, soumission
   * DocuSeal intégrée (embed_src), EN_SIGNATURE. Idempotent : une soumission
   * active existante est renvoyée telle quelle.
   * `acceptorRecipientId` : destinataire dont on renvoie le lien intégré.
   */
  async start(scope: Scope, proposalId: string, acceptorRecipientId: string | null, now: Date) {
    await this.availability.assertEnabled(scope);
    const settings = proposalSettingsFrom(await this.config.settings(scope));
    const defaultOrder = await this.config.setting(scope, 'signature.defaultOrder');
    const expireDays = await this.config.setting(scope, 'signature.expireDays');

    // --- tx1 : valider, préparer les signataires, demande CREATING --------------
    const prepared = await withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id: proposalId }, include: { owner: true, template: { select: { providerCountersign: true } } } });
      if (!p) throw new NotFoundException('Proposition introuvable');
      const active = await tx.proposalSignatureRequest.findFirst({
        where: { proposalId, status: { in: ['CREATING', 'SENT', 'PARTIALLY_COMPLETED'] } },
        include: { signers: true },
      });
      if (active) return { existing: active, p } as const;
      if (p.status !== 'ACCEPTED' || !p.acceptedSnapshotId) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_ACCEPTED', detail: 'Seule une proposition acceptée part en signature.' });
      }
      const snapshot = await tx.pricingSnapshot.findUniqueOrThrow({ where: { id: p.acceptedSnapshotId } });
      const recipients = await tx.proposalRecipient.findMany({ where: { proposalId, role: 'SIGNER' }, orderBy: [{ signingOrder: 'asc' }, { createdAt: 'asc' }] });
      if (recipients.length === 0) throw new ConflictException({ code: 'NO_SIGNER', detail: 'Aucun signataire désigné.' });
      const lsiUserId = settings.lsiSignerUserId ?? p.ownerUserId;
      const lsiUser = await tx.user.findUnique({ where: { id: lsiUserId }, select: { id: true, fullName: true, email: true } });
      const requestId = uuidv7();
      const expireAt = p.expiresAt && p.expiresAt > now ? p.expiresAt : new Date(now.getTime() + expireDays * 86_400_000);
      // Ordre : client puis LSI par défaut (paramètre du tenant, brief §7).
      const lsiFirst = defaultOrder === 'LSI_FIRST';
      const countersign = p.template ? p.template.providerCountersign : true;
      await tx.proposalSignatureRequest.create({
        data: {
          id: requestId, tenantId: p.tenantId, customerId: p.customerId, proposalId, versionId: snapshot.versionId,
          snapshotId: snapshot.id, status: 'CREATING', idempotencyKey: `proposal-${proposalId}-${snapshot.id}`,
          expireAt, delivery: 'EMBEDDED', signingOrder: lsiFirst ? 'LSI_THEN_CLIENT' : 'CLIENT_THEN_LSI',
          createdAt: now, updatedAt: now, createdByUserId: null,
        },
      });
      const signers = [
        ...recipients.map((r: any, i: number) => ({
          id: uuidv7(), party: 'CLIENT' as const, recipientId: r.id, userId: null, fullName: r.fullName, email: r.email,
          roleLabel: i === 0 ? 'Client' : `Client ${i + 1}`, signingOrder: (lsiFirst ? 1 : 0) + i,
        })),
        ...(countersign && lsiUser
          ? [{ id: uuidv7(), party: 'LSI' as const, recipientId: null, userId: lsiUser.id, fullName: lsiUser.fullName, email: lsiUser.email,
               roleLabel: 'LSI Maintenance', signingOrder: lsiFirst ? 0 : recipients.length }]
          : []),
      ];
      await tx.proposalSigner.createMany({
        data: signers.map((s) => ({
          id: s.id, tenantId: p.tenantId, customerId: p.customerId, proposalId, signatureRequestId: requestId, party: s.party,
          recipientId: s.recipientId, userId: s.userId, fullName: s.fullName, email: s.email, signingOrder: s.signingOrder,
          status: 'PENDING', createdAt: now, updatedAt: now,
        })),
      });
      return { existing: null, p, requestId, snapshot, signers, expireAt } as const;
    });

    if (prepared.existing) return this.embedFor(prepared.existing.signers, acceptorRecipientId, prepared.existing.id);

    const { p, requestId, snapshot, signers, expireAt } = prepared;
    try {
      // --- I/O HORS transaction : PDF figé (haché avant envoi), soumission ---------
      const quote = this.snapshotQuote(snapshot);
      const pdfSigners: SignerForPdf[] = signers.map((s) => ({ roleLabel: s.roleLabel, fullName: s.fullName, party: s.party }));
      const rendered = await this.docs.signaturePdf(scope, proposalId, requestId, quote, pdfSigners, settings, now);
      await withScope(scope, (tx) =>
        tx.proposalSignatureRequest.update({ where: { id: requestId }, data: { sentPdfObjectKey: rendered.key, sentPdfSha256: rendered.sha256 } }),
      );
      const submitters: SubmitterCommand[] = signers.map((s) => ({
        party: s.party, roleLabel: s.roleLabel, externalId: s.id, fullName: s.fullName, email: s.email,
        signingOrder: s.signingOrder, requireEmail2fa: s.party === 'CLIENT', fields: [],
      }));
      const submission = await this.provider.createSubmission({
        pdf: rendered.pdf,
        pdfSha256: rendered.sha256,
        documentName: rendered.filename,
        signingOrder: 'AS_DEFINED',
        delivery: 'EMBEDDED',
        expireAt,
        subject: `Proposition ${p.number} — signature`,
        body: 'Bonjour,\n\nVeuillez signer : {{submitter.link}}',
        completedRedirectUrl: `${process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr'}/p/signature-complete`,
        submitters,
        metadata: { tenant_id: p.tenantId, customer_id: p.customerId, proposal_id: proposalId, proposal_signature_request_id: requestId },
      });
      // --- tx2 : acter l'envoi, EN_SIGNATURE -----------------------------------------
      return await withScope(scope, async (tx) => {
        await tx.proposalSignatureRequest.update({
          where: { id: requestId },
          data: { status: 'SENT', providerSubmissionId: submission.providerSubmissionId, lastSyncedAt: now, updatedAt: now },
        });
        for (const s of submission.submitters) {
          if (!s.externalId) continue;
          await tx.proposalSigner.update({
            where: { id: s.externalId },
            data: { status: 'SENT', providerSubmitterId: s.providerSubmitterId, providerSubmitterSlug: s.slug, embedSrc: s.embedSrc ?? null, updatedAt: now },
          });
        }
        await persistProposalTransition(tx, proposalId, { type: 'START_SIGNATURE' }, { now });
        const rows = await tx.proposalSigner.findMany({ where: { signatureRequestId: requestId } });
        return this.embedFor(rows, acceptorRecipientId, requestId);
      });
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : (e as Error).message;
      await withScope(scope, (tx) =>
        tx.proposalSignatureRequest.update({ where: { id: requestId }, data: { status: 'FAILED', errorMessage: msg.slice(0, 500), updatedAt: new Date() } }),
      );
      this.log.error(`soumission DocuSeal de la proposition ${p.number} en échec : ${msg}`);
      throw e;
    }
  }

  private embedFor(signers: readonly any[], recipientId: string | null, requestId: string) {
    const mine = signers.find((s) => s.recipientId && s.recipientId === recipientId);
    return { signatureRequestId: requestId, embedSrc: mine?.embedSrc ?? null };
  }

  /** Barème figé → devis (même moteur) : la page de signature affiche exactement le prix figé. */
  snapshotQuote(snapshot: { definition: unknown; selection: unknown; engineSchedule: unknown }): ProposalQuote {
    const sel = snapshot.selection as { choices: Record<string, string>; quantities: Record<string, number>; selectedOptions: string[] };
    const sched = snapshot.engineSchedule as { validFrom: string };
    return quoteProposal(
      snapshot.definition as ProposalPricingDefinition,
      { choices: sel.choices, quantities: sel.quantities, selectedOptions: sel.selectedOptions, context: pricingContextOf({}) },
      { date: sched.validFrom ?? parisDay(new Date()) },
    );
  }

  // -------------------------------------------------------------------------
  // Webhooks (appelé par DocusealWebhookService, APRÈS vérification HMAC)
  // -------------------------------------------------------------------------

  async process(event: NormalizedSignatureEvent): Promise<{ status: ProposalWebhookOutcome }> {
    const req = await resolveProposalWebhookScope('DOCUSEAL', event.providerSubmissionId);
    if (!req) return { status: 'unknown_submission' };
    const claimed = event.untrustedMetadata?.['tenant_id'];
    if (claimed && claimed !== req.tenantId) {
      this.log.error(`ALERTE SÉCURITÉ : metadata webhook incohérente (proposition) submission=${event.providerSubmissionId}`);
      return { status: 'rejected' };
    }
    const scope = systemScope(req.tenantId, req.customerId);
    const notices: (ProposalNotice | null)[] = [];
    const now = new Date();
    const result = await withScope(scope, async (tx) => {
      // Idempotence par contrainte UNIQUE, sans exception dans la transaction.
      const inserted = await tx.proposalSignatureEvent.createMany({
        data: [{
          id: uuidv7(), tenantId: req.tenantId, customerId: req.customerId, proposalId: req.proposalId,
          signatureRequestId: req.signatureRequestId, providerEventId: event.eventId, eventType: event.kind,
          submitterEmail: event.submitterEmail, occurredAt: event.occurredAt, receivedAt: now, rawPayload: event.rawPayload as object,
        }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { status: 'duplicate_ignored' as const, capture: false };
      const current = await tx.proposalSignatureRequest.findUniqueOrThrow({ where: { id: req.signatureRequestId } });
      const done = () => tx.proposalSignatureEvent.updateMany({ where: { providerEventId: event.eventId }, data: { processedAt: now } });
      if (CLOSED.has(current.status)) {
        await done();
        return { status: 'closed_ignored' as const, capture: false };
      }
      const signer = event.externalSignerId
        ? await tx.proposalSigner.findUnique({ where: { id: event.externalSignerId } })
        : event.providerSubmitterId
          ? await tx.proposalSigner.findFirst({ where: { providerSubmitterId: event.providerSubmitterId } })
          : null;
      let capture = false;
      switch (event.kind) {
        case 'FORM_VIEWED':
          if (signer?.status === 'SENT') await tx.proposalSigner.update({ where: { id: signer.id }, data: { status: 'VIEWED', updatedAt: now } });
          break;
        case 'FORM_STARTED':
          break;
        case 'FORM_DECLINED': {
          if (signer?.status === 'SIGNED') break;
          if (signer) await tx.proposalSigner.update({ where: { id: signer.id }, data: { status: 'DECLINED', declinedAt: now, declineReason: event.declineReason, updatedAt: now } });
          await tx.proposalSignatureRequest.update({ where: { id: current.id }, data: { status: 'DECLINED', lastSyncedAt: now, updatedAt: now } });
          await this.transition(tx, req.proposalId, { type: 'SIGNATURE_DECLINED', reason: event.declineReason ?? 'refus de signature' }, now);
          notices.push(await this.ownerNotice(tx, req.proposalId, 'proposal.signature_declined', 'signature refusée',
            `La signature a été refusée${event.declineReason ? ` (${event.declineReason})` : ''} : la proposition revient en discussion.`, now));
          break;
        }
        case 'SUBMISSION_EXPIRED':
          await tx.proposalSignatureRequest.update({ where: { id: current.id }, data: { status: 'EXPIRED', lastSyncedAt: now, updatedAt: now } });
          await this.transition(tx, req.proposalId, { type: 'SIGNATURE_EXPIRED' }, now);
          notices.push(await this.ownerNotice(tx, req.proposalId, 'proposal.signature_declined', 'soumission expirée',
            'La soumission DocuSeal a expiré : la proposition revient en discussion.', now));
          break;
        case 'FORM_COMPLETED': {
          if (signer?.status === 'SIGNED') break;
          if (signer) await tx.proposalSigner.update({ where: { id: signer.id }, data: { status: 'SIGNED', signedAt: now, updatedAt: now } });
          const remaining = await tx.proposalSigner.count({ where: { signatureRequestId: current.id, status: { not: 'SIGNED' } } });
          await tx.proposalSignatureRequest.update({
            where: { id: current.id },
            data: { status: remaining > 0 ? 'PARTIALLY_COMPLETED' : 'COMPLETED', lastSyncedAt: now, updatedAt: now },
          });
          capture = remaining === 0;
          break;
        }
        case 'SUBMISSION_COMPLETED':
          // AUTORITAIRE (comme pour les contrats) : toutes les parties ont signé.
          await tx.proposalSigner.updateMany({ where: { signatureRequestId: current.id, status: { not: 'SIGNED' } }, data: { status: 'SIGNED', signedAt: now, updatedAt: now } });
          await tx.proposalSignatureRequest.update({ where: { id: current.id }, data: { status: 'COMPLETED', lastSyncedAt: now, updatedAt: now } });
          capture = true;
          break;
      }
      await done();
      return { status: 'processed' as const, capture };
    });
    await this.notifier.flush(notices);
    if (result.status === 'processed' && result.capture) {
      await this.jobs
        .enqueueCapture({ proposalId: req.proposalId, tenantId: req.tenantId, customerId: req.customerId, signatureRequestId: req.signatureRequestId })
        .catch((e: Error) => this.log.warn(`capture non enfilée (rattrapée par le balayage) : ${e.message}`));
    }
    return { status: result.status };
  }

  private async transition(tx: any, proposalId: string, event: Parameters<typeof persistProposalTransition>[2], now: Date) {
    try {
      await persistProposalTransition(tx, proposalId, event, { now });
    } catch (e) {
      // Webhook en retard sur une proposition déjà ailleurs : journalisé, sans 5xx.
      this.log.warn(`transition ${event.type} ignorée sur la proposition ${proposalId} : ${(e as Error).message}`);
    }
  }

  private async ownerNotice(tx: any, proposalId: string, type: ProposalNotice['type'], what: string, body: string, now: Date) {
    const p = await tx.proposal.findUnique({ where: { id: proposalId }, include: { owner: { select: { email: true } } } });
    if (!p) return null;
    return this.notifier.record(tx, {
      tenantId: p.tenantId, customerId: p.customerId, proposalId, recipientUserId: p.ownerUserId, recipientEmail: p.owner?.email ?? null,
      type, subject: `${p.number} : ${what}`, body, dedupKey: `${type}:${proposalId}:${now.getTime()}`,
    }, now);
  }

  // -------------------------------------------------------------------------
  // Preuves, puis SIGNÉE (job `proposal-capture`)
  // -------------------------------------------------------------------------

  async capture(tenantId: string, customerId: string, signatureRequestId: string, now: Date): Promise<boolean> {
    const scope = systemScope(tenantId, customerId);
    const sr = await withScope(scope, (tx) => tx.proposalSignatureRequest.findUnique({ where: { id: signatureRequestId } }));
    if (!sr || sr.status !== 'COMPLETED' || !sr.providerSubmissionId) return false;
    if (!sr.signedPdfObjectKey) {
      const docs = await this.provider.downloadCompletedDocuments(sr.providerSubmissionId);
      const obj = { tenantId, customerId };
      const prefix = `t/${tenantId}/c/${customerId}/proposals/${sr.proposalId}/signature/${sr.id}`;
      const signedKey = `${prefix}/document-signe.pdf`;
      const signedHash = sha256Hex(docs.mergedPdf);
      await this.docs.put(obj, signedKey, docs.mergedPdf);
      let auditKey: string | null = null;
      let auditHash: string | null = null;
      if (docs.auditLogPdf) {
        auditKey = `${prefix}/journal-signature.pdf`;
        auditHash = sha256Hex(docs.auditLogPdf);
        await this.docs.put(obj, auditKey, docs.auditLogPdf);
      }
      let relation: 'IDENTICAL' | 'SIGNED_OVERLAY' | null = null;
      try {
        relation = sr.sentPdfSha256 ? linkDocumentHashes(sr.sentPdfSha256, signedHash).relation : null;
      } catch {
        relation = null;
      }
      await withScope(scope, async (tx) => {
        await tx.proposalSignatureRequest.update({
          where: { id: sr.id },
          data: { signedPdfObjectKey: signedKey, signedPdfSha256: signedHash, auditTrailObjectKey: auditKey, auditTrailSha256: auditHash, hashRelation: relation, updatedAt: now },
        });
        const sent = sr.sentPdfSha256
          ? await tx.storedDocument.findFirst({ where: { proposalId: sr.proposalId, kind: 'PROPOSAL_PDF', sha256: sr.sentPdfSha256 }, select: { id: true } })
          : null;
        await tx.storedDocument.createMany({
          data: [
            { id: uuidv7(), tenantId, customerId, proposalId: sr.proposalId, kind: 'PROPOSAL_SIGNED_PDF' as const, origin: 'DOCUSEAL' as const,
              objectKey: signedKey, filename: 'proposition-signee.pdf', contentType: 'application/pdf', sizeBytes: BigInt(docs.mergedPdf.length),
              sha256: signedHash, derivedFromId: sent?.id ?? null, createdAt: now },
            ...(auditKey && auditHash && docs.auditLogPdf
              ? [{ id: uuidv7(), tenantId, customerId, proposalId: sr.proposalId, kind: 'PROPOSAL_AUDIT_TRAIL' as const, origin: 'DOCUSEAL' as const,
                  objectKey: auditKey, filename: 'journal-signature.pdf', contentType: 'application/pdf', sizeBytes: BigInt(docs.auditLogPdf.length),
                  sha256: auditHash, derivedFromId: null, createdAt: now }]
              : []),
          ],
          skipDuplicates: true,
        });
      });
    }
    // Preuves archivées : la proposition passe SIGNÉE (idempotent : déjà SIGNÉE → rien).
    const notices: (ProposalNotice | null)[] = [];
    const signed = await withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id: sr.proposalId } });
      if (!p || p.status !== 'PENDING_SIGNATURE') return false;
      await persistProposalTransition(tx, p.id, { type: 'SIGNATURE_COMPLETED' }, { now });
      await tx.customer.updateMany({ where: { id: p.customerId, commercialStatus: 'PROSPECT' }, data: { commercialStatus: 'CLIENT', updatedAt: now } });
      notices.push(await this.ownerNotice(tx, p.id, 'proposal.signed', 'proposition signée', `La proposition ${p.number} est signée : le contrat va être généré.`, now));
      return true;
    });
    await this.notifier.flush(notices);
    if (signed) {
      await this.jobs.enqueueConvert({ proposalId: sr.proposalId, tenantId, customerId }).catch((e: Error) =>
        this.log.warn(`conversion non enfilée (rattrapée par le balayage) : ${e.message}`),
      );
    }
    return true;
  }
}
