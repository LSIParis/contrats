import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { planFollowUps, formatMergeValue, DEFAULT_FOLLOW_UPS, type EmailSender, type FollowUpConfig } from '@lsi/domain';
import { EMAIL_SENDER } from '../notifications/email.token.js';
import { sha256Hex, stableStringify } from './proposal-content.js';
import { newToken, publicLink, renderEmailTemplate } from './proposal-links.js';
import { computeState, loadProposal, loadTemplateDefinition, parisDay, type ProposalSettings } from './proposal-state.js';
import { persistProposalTransition } from './proposal-transition.js';
import { ProposalDocumentsService } from './proposal-documents.service.js';
import { actorOf, cancelFollowUps, ProposalsService } from './proposals.service.js';

const DAY = 86_400_000;

/** Fin du jour calendaire `day` à Paris (23:59:59.999, heure légale comprise). */
export function parisEndOfDay(day: string): Date {
  for (const offset of ['+01:00', '+02:00']) {
    const d = new Date(`${day}T23:59:59.999${offset}`);
    if (parisDay(d) === day && parisDay(new Date(d.getTime() + 1)) !== day) return d;
  }
  return new Date(`${day}T22:59:59.999Z`);
}

interface OutgoingMail {
  readonly recipientId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly kind: 'INITIAL' | 'RESEND' | 'NEW_VERSION' | 'REVISION_NOTICE';
}

/**
 * Envoi, renvoi, nouvelle version, réactivation (brief §12.2, §12.5).
 *
 * Même découpage que l'envoi en signature d'un contrat : la transaction fige
 * la version, crée les liens (jetons hachés) et acte la transition ; l'I/O
 * (rendu PDF, e-mails) vient APRÈS le commit et ne peut plus rien défaire —
 * un e-mail en échec est tracé dans l'historique des envois et se renvoie.
 */
@Injectable()
export class ProposalSendService {
  private readonly log = new Logger(ProposalSendService.name);

  constructor(
    private readonly proposals: ProposalsService,
    private readonly docs: ProposalDocumentsService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async send(scope: Scope, id: string, now: Date) {
    await this.proposals.assertEnabled(scope);
    const settings = await this.proposals.settings(scope);
    const result = await withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const { proposal, version, recipients } = loaded;
      const templateDefinition = await loadTemplateDefinition(tx, proposal.templateId);
      const state = computeState(loaded, settings, now, { templateDefinition });
      const c = state.counters;
      if (c.unresolvedMergeTags || c.blockingValidations || c.pricingErrors || !c.hasRecipients || !c.hasSigner) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_READY', detail: 'La proposition n’est plus prête à partir.', issues: state.issues });
      }

      // Échéance : conservée si une réactivation l'a fixée, sinon date fixe ou N jours après l'envoi.
      const expiresAt =
        version.lockedAt && proposal.expiresAt && proposal.expiresAt > now
          ? proposal.expiresAt
          : proposal.fixedExpiryDate
            ? parisEndOfDay(proposal.fixedExpiryDate.toISOString().slice(0, 10))
            : new Date(now.getTime() + proposal.validityDays * DAY);

      if (!version.lockedAt) {
        // FIGER la version : valeurs de fusion (échéance réelle), tableau de prix
        // (statuts validés compris), empreinte du contenu. Ensuite, immuable (trigger).
        const frozen = computeState(loaded, settings, now, { templateDefinition, expiryDay: parisDay(expiresAt) });
        const content = stableStringify({
          title: version.title,
          cover: version.cover,
          sections: frozen.sections,
          pricingDefinition: frozen.definition,
          mergeValues: frozen.mergeValues,
          terms: version.terms ? { id: version.terms.id, sha256: version.terms.sha256 } : null,
        });
        await tx.proposalVersion.update({
          where: { id: version.id },
          data: { mergeValues: frozen.mergeValues, pricingDefinition: frozen.definition as object, contentSha256: sha256Hex(content), lockedAt: now },
        });
      }
      // Un seul lien valide par destinataire et par version.
      await tx.proposalAccessLink.updateMany({
        where: { proposalId: id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'NOUVEL_ENVOI' },
      });
      const links = recipients.map((r: any) => ({ recipient: r, ...newToken() }));
      await tx.proposalAccessLink.createMany({
        data: links.map((l: any) => ({
          id: uuidv7(), tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: id, versionId: version.id,
          recipientId: l.recipient.id, tokenHash: l.hash, expiresAt: new Date(expiresAt.getTime() + settings.linkGraceDays * DAY), createdAt: now,
        })),
      });
      await persistProposalTransition(tx, id, { type: 'SEND', expiresAt }, { now, userId: actorOf(scope), readiness: c });

      // Relances planifiées (J+3, J+7, J-2 par défaut).
      await cancelFollowUps(tx, id, now, 'NOUVEL_ENVOI');
      if (proposal.followUpsEnabled) {
        const cfg = (proposal.followUpConfig as FollowUpConfig | null) ?? settings.followUps ?? DEFAULT_FOLLOW_UPS;
        const plan = planFollowUps(now, expiresAt, cfg);
        if (plan.length) {
          await tx.proposalFollowUp.createMany({
            data: plan.map((f) => ({
              id: uuidv7(), tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: id,
              kind: f.kind, dueAt: f.dueAt, status: 'PLANNED', createdAt: now, updatedAt: now,
            })),
            skipDuplicates: true,
          });
        }
      }
      const mails = links.map((l: any): OutgoingMail => this.mail(settings, loaded, l.recipient, l.token, expiresAt, version.lockedAt ? 'RESEND' : 'INITIAL'));
      return { mails, versionId: version.id, owner: proposal.owner };
    });

    // APRÈS commit : PDF de la version (figé, haché, stocké une fois), puis e-mails.
    try {
      await this.docs.versionPdf(scope, id, settings, now);
    } catch (e) {
      this.log.warn(`PDF de la proposition ${id} non rendu à l’envoi (rendu différé) : ${(e as Error).message}`);
    }
    await this.deliver(scope, id, result.versionId, result.mails, result.owner, now);
    return this.proposals.get(scope, id, now);
  }

  /** Renvoi en un clic : nouveau lien (l'ancien est révoqué), historique tracé. */
  async resend(scope: Scope, id: string, recipientId: string | undefined, now: Date) {
    await this.proposals.assertEnabled(scope);
    const settings = await this.proposals.settings(scope);
    const result = await withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const { proposal, version } = loaded;
      if (!['SENT', 'VIEWED', 'IN_DISCUSSION'].includes(proposal.status) || !proposal.expiresAt) {
        throw new ConflictException({ code: 'PROPOSAL_NOT_SENT', detail: 'Seule une proposition envoyée et non décidée se renvoie.' });
      }
      const targets = loaded.recipients.filter((r: any) => !recipientId || r.id === recipientId);
      if (targets.length === 0) throw new NotFoundException('Destinataire introuvable');
      await tx.proposalAccessLink.updateMany({
        where: { proposalId: id, recipientId: { in: targets.map((r: any) => r.id) }, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'RENVOI' },
      });
      const links = targets.map((r: any) => ({ recipient: r, ...newToken() }));
      await tx.proposalAccessLink.createMany({
        data: links.map((l: any) => ({
          id: uuidv7(), tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: id, versionId: version.id,
          recipientId: l.recipient.id, tokenHash: l.hash,
          expiresAt: new Date(proposal.expiresAt.getTime() + settings.linkGraceDays * DAY), createdAt: now,
        })),
      });
      return {
        mails: links.map((l: any): OutgoingMail => this.mail(settings, loaded, l.recipient, l.token, proposal.expiresAt, 'RESEND')),
        versionId: version.id,
        owner: proposal.owner,
      };
    });
    await this.deliver(scope, id, result.versionId, result.mails, result.owner, now);
    return this.proposals.get(scope, id, now);
  }

  /**
   * Nouvelle version (brief §12.2 « verrouillage ») : la version envoyée est
   * REMPLACÉE tout de suite (V2-H41), ses liens révoqués, les destinataires
   * prévenus ; la nouvelle version repart en brouillon (revue, préparation,
   * envoi). Depuis PRÊTE (rien d'envoyé), simple retour en brouillon.
   */
  async revise(scope: Scope, id: string, reason: string, now: Date) {
    await this.proposals.assertEnabled(scope);
    const settings = await this.proposals.settings(scope);
    const userId = actorOf(scope);
    const notices = await withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, id);
      const { proposal, version } = loaded;
      const templateDefinition = await loadTemplateDefinition(tx, proposal.templateId);
      const state = computeState(loaded, settings, now, { templateDefinition });
      await persistProposalTransition(tx, id, { type: 'REVISE', reason }, { now, userId, readiness: state.counters });
      if (!version.lockedAt) return [] as OutgoingMail[];

      await tx.proposalVersion.update({ where: { id: version.id }, data: { supersededAt: now } });
      await tx.proposalAccessLink.updateMany({ where: { proposalId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'VERSION_REMPLACEE' } });
      await cancelFollowUps(tx, id, now, 'VERSION_REMPLACEE');

      const nextId = uuidv7();
      const terms = await tx.proposalTerms.findFirst({ where: { tenantId: proposal.tenantId }, orderBy: { versionNumber: 'desc' } });
      await tx.proposalVersion.create({
        data: {
          id: nextId, tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: id,
          versionNumber: version.versionNumber + 1, title: version.title, cover: version.cover as object,
          pricingDefinition: version.pricingDefinition as object, pricingSettings: version.pricingSettings as object,
          termsId: terms?.id ?? version.termsId, changeSummary: reason, createdAt: now, createdByUserId: userId ?? proposal.ownerUserId,
        },
      });
      await this.proposals.writeSections(
        tx,
        { tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: id, versionId: nextId },
        version.sections.map((s: any) => ({
          key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded,
          libraryItemKey: s.libraryItemKey, guidance: s.guidance,
          blocks: s.blocks.map((b: any) => ({ type: b.type, content: b.content })),
        })),
        new Map(version.sections.map((s: any) => [s.key, s.validationStatus])),
      );
      // La dernière configuration du client est reprise : on ne lui fait rien ressaisir.
      if (loaded.latestSelection) {
        const s = loaded.latestSelection;
        await tx.proposalSelection.create({
          data: {
            id: uuidv7(), tenantId: s.tenantId, customerId: s.customerId, proposalId: id, versionId: nextId,
            choices: s.choices as object, quantities: s.quantities as object, selectedOptions: s.selectedOptions as object,
            oneTimeCents: s.oneTimeCents, monthlyCents: s.monthlyCents, quarterlyCents: s.quarterlyCents, yearlyCents: s.yearlyCents,
            commitmentTotalCents: s.commitmentTotalCents, commitmentMonths: s.commitmentMonths, errors: s.errors as object,
            actorKind: 'SYSTEM', userId, recipientId: null, createdAt: now,
          },
        });
      }
      await tx.proposal.update({ where: { id }, data: { currentVersionId: nextId, updatedAt: now } });
      return loaded.recipients.map((r: any): OutgoingMail => ({
        recipientId: r.id,
        to: r.email,
        kind: 'REVISION_NOTICE',
        subject: `Proposition ${proposal.number} : une nouvelle version est en préparation`,
        text:
          `Bonjour ${r.fullName},\n\nLa proposition ${proposal.number} est en cours de modification par ${proposal.owner?.fullName ?? 'LSI Maintenance'}. ` +
          `Le lien reçu précédemment n'est plus valable : vous recevrez la nouvelle version dès qu'elle sera prête.\n`,
      }));
    });
    if (notices.length) {
      const loaded = await withScope(scope, (tx) => loadProposal(tx, id));
      const previous = await withScope(scope, (tx) =>
        tx.proposalVersion.findFirst({ where: { proposalId: id, supersededAt: { not: null } }, orderBy: { versionNumber: 'desc' }, select: { id: true } }),
      );
      await this.deliver(scope, id, previous?.id ?? loaded.version.id, notices, loaded.proposal.owner, now);
    }
    return this.proposals.get(scope, id, now);
  }

  /** EXPIRÉE → PRÊTE avec une nouvelle échéance ; motif tracé (brief §12.2). */
  async reactivate(scope: Scope, id: string, reason: string, expiresOn: string, now: Date) {
    return this.proposals.transition(scope, id, { type: 'REACTIVATE', reason, expiresAt: parisEndOfDay(expiresOn) }, now);
  }

  private mail(
    settings: ProposalSettings,
    loaded: { proposal: any; version: any },
    recipient: { id: string; email: string; fullName: string },
    token: string,
    expiresAt: Date,
    kind: OutgoingMail['kind'],
  ): OutgoingMail {
    const { proposal } = loaded;
    const values: Record<string, string> = {
      'proposition.numero': proposal.number,
      'proposition.dateExpiration': formatMergeValue('proposition.dateExpiration', parisDay(expiresAt)) ?? '',
      'client.raisonSociale': proposal.customer.legalName ?? proposal.customer.name,
      'commercial.nom': proposal.owner?.fullName ?? 'LSI Maintenance',
      'destinataire.nom': recipient.fullName,
      lien: publicLink(token),
    };
    return {
      recipientId: recipient.id,
      to: recipient.email,
      kind,
      subject: renderEmailTemplate(settings.emailSubject, values),
      text: renderEmailTemplate(settings.emailBody, values),
    };
  }

  /** Envoie puis trace chaque e-mail (succès ou erreur) dans l'historique des envois. */
  private async deliver(scope: Scope, id: string, versionId: string, mails: readonly OutgoingMail[], owner: { fullName: string; email: string } | null, now: Date) {
    const rows: { m: OutgoingMail; error: string | null }[] = [];
    for (const m of mails) {
      let error: string | null = null;
      try {
        await this.email.send({
          to: m.to,
          subject: m.subject,
          text: m.text,
          // Expéditeur « au nom du commercial », adresse technique du domaine (SPF/DKIM/DMARC).
          ...(owner ? { fromName: `${owner.fullName} — LSI Maintenance`, replyTo: owner.email } : {}),
        });
      } catch (e) {
        error = (e as Error).message.slice(0, 500);
        this.log.warn(`e-mail de proposition non envoyé (${m.kind}) : ${error}`);
      }
      rows.push({ m, error });
    }
    await withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id }, select: { tenantId: true, customerId: true } });
      if (!p) return;
      await tx.proposalDelivery.createMany({
        data: rows.map(({ m, error }) => ({
          id: uuidv7(), tenantId: p.tenantId, customerId: p.customerId, proposalId: id, versionId,
          recipientId: m.recipientId, kind: m.kind, subject: m.subject, sentByUserId: actorOf(scope), error, sentAt: now,
        })),
      });
    });
  }
}
