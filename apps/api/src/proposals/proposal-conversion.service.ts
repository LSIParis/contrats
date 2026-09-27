import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { setTransitionContext, systemScope, uuidv7, withScope } from '@lsi/persistence';
import type { PricingLine as EngineLine, PricingSchedule as EngineSchedule } from '@lsi/pricing';
import { StructureService } from '../structure/structure.service.js';
import { publishContractTransition } from '../webhooks-out/contract-producers.js';
import { ProposalNotifier, type ProposalNotice } from './proposal-notifier.service.js';
import { parisDay } from './proposal-state.js';
import { persistProposalTransition } from './proposal-transition.js';

/** Erreur définitive de conversion (contrat type introuvable…) : tracée, retentée par le job. */
export class ConversionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

const addMonths = (d: Date, months: number): Date => {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
  // Fin de mois rabattue (31 janvier + 1 mois → 28/29 février).
  if (r.getUTCDate() !== d.getUTCDate()) r.setUTCDate(0);
  return r;
};
const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Conversion automatique d'une proposition SIGNÉE en contrat (brief §12.7).
 *
 *   - contrat `origin = PROPOSAL`, lié à la proposition (`contracts.proposal_id`,
 *     UNIQUE) ET réciproquement (`proposals.contract_id`) ;
 *   - client, signataires (destinataires signataires), durée d'engagement,
 *     date d'effet souhaitée, montant mensuel ;
 *   - texte : version PUBLIÉE du contrat type associé au modèle de proposition
 *     (clauses copiées, annexes par défaut, variables pré-remplies) ;
 *   - barème initial = PricingSnapshot, ligne pour ligne : les lignes du
 *     moteur figées à l'acceptation sont écrites telles quelles (révision
 *     Syntec à la date anniversaire pour les lignes indexées) ;
 *   - option `signedProposalIsContract` (désactivée par défaut, à valider par
 *     un juriste) : contrat directement ACTIF, barème ACTIF, preuve = la
 *     proposition signée (`signed_via_proposal`, signatureMode PROPOSAL_SIGNED).
 *
 * IDEMPOTENTE par construction : tout s'écrit dans UNE transaction, et
 * `contracts_proposal_key` (UNIQUE) refuse un second contrat pour la même
 * proposition. Un webhook rejoué ou deux jobs concurrents : l'un crée,
 * l'autre relit le contrat existant.
 */
@Injectable()
export class ProposalConversionService {
  private readonly log = new Logger(ProposalConversionService.name);

  constructor(
    private readonly structure: StructureService,
    private readonly notifier: ProposalNotifier,
  ) {}

  async convert(tenantId: string, customerId: string, proposalId: string, now: Date): Promise<{ contractId: string; created: boolean }> {
    const scope = systemScope(tenantId, customerId);
    const notices: (ProposalNotice | null)[] = [];
    try {
      const out = await withScope(scope, async (tx) => {
        const p = await tx.proposal.findUnique({ where: { id: proposalId }, include: { template: true, owner: { select: { email: true } } } });
        if (!p) throw new ConversionError('Proposition introuvable', 'NOT_FOUND');
        const existing = await tx.contract.findUnique({ where: { proposalId }, select: { id: true } });
        if (existing || p.contractId) {
          const contractId = existing?.id ?? (p.contractId as string);
          if (p.status === 'SIGNED') {
            await persistProposalTransition(tx, p.id, { type: 'CONVERT', contractId }, { now, extra: { contractId, conversionError: null } });
          }
          return { contractId, created: false };
        }
        if (p.status !== 'SIGNED' || !p.acceptedSnapshotId) {
          throw new ConversionError(`Proposition ${p.number} non signée (${p.status}) : pas de conversion.`, 'NOT_SIGNED');
        }
        const snapshot = await tx.pricingSnapshot.findUniqueOrThrow({ where: { id: p.acceptedSnapshotId } });

        // Contrat type associé (annexe C, règle 8) : sa version PUBLIÉE fait le texte.
        let templateVersionId: string | null = null;
        let category = 'MAINTENANCE';
        if (p.template) {
          const ct = await tx.contractTemplate.findFirst({ where: { tenantId, slug: p.template.contractTemplateSlug } });
          if (!ct?.currentVersionId) {
            throw new ConversionError(
              `Contrat type « ${p.template.contractTemplateSlug} » introuvable ou non publié : créez-le (et son slug) pour générer le contrat.`,
              'CONTRACT_TEMPLATE_MISSING',
            );
          }
          templateVersionId = ct.currentVersionId;
          category = ct.category;
        }

        const asContract = p.signedProposalIsContract;
        const signedAt = p.signedAt ?? now;
        const startDate = p.desiredStartDate ?? (asContract ? new Date(`${parisDay(signedAt)}T00:00:00Z`) : null);
        const months = snapshot.commitmentMonths;
        const endDate = startDate && months > 0 ? dayBefore(addMonths(startDate, months)) : null;
        const id = uuidv7();
        const versionId = uuidv7();
        // Référence dérivée du numéro de proposition (unique par tenant) : aucun
        // compteur partagé à relire hors du portefeuille du scope système (V2-H57).
        const reference = p.number.replace(/^PROP-(\d{4})-(\d+)$/, 'LSI-$1-P$2');

        await setTransitionContext(tx, { event: 'CREATE_FROM_PROPOSAL', reason: p.number });
        const contract = await tx.contract.create({
          data: {
            id, tenantId, customerId, reference, title: p.title, type: 'MAIN',
            status: asContract ? 'ACTIVE' : 'DRAFT', category: category as never, origin: 'PROPOSAL',
            proposalId: p.id, signedViaProposal: asContract, templateVersionId, currentVersionId: versionId,
            startDate, endDate, amountCents: snapshot.monthlyCents, billingFrequency: 'MONTHLY',
            signedAt: asContract ? signedAt : null, activatedAt: asContract ? now : null,
            ownerUserId: p.ownerUserId, createdAt: now, updatedAt: now,
            // Acteur SYSTÈME (webhook, job) : la colonne exige un utilisateur, on
            // retient le commercial propriétaire — le journal dit SYSTEM.
            createdByUserId: p.ownerUserId, updatedByUserId: p.ownerUserId,
          },
        });

        // Barème initial = PricingSnapshot (avant le texte : l'annexe « grille
        // tarifaire » se rend depuis le barème du contrat).
        const sched = snapshot.engineSchedule as unknown as EngineSchedule;
        const def = snapshot.definition as { lines?: { key: string; indexation?: { index: string; a: number; b: number } }[] };
        const indexed = new Map((def.lines ?? []).filter((l) => l.indexation).map((l) => [l.key, l.indexation!]));
        const validFrom = startDate ? iso(startDate) : sched.validFrom;
        const scheduleId = uuidv7();
        await tx.pricingSchedule.create({
          data: {
            id: scheduleId, tenantId, customerId, contractId: id, versionNumber: 1, status: 'DRAFT',
            validFrom: new Date(`${validFrom}T00:00:00Z`), validTo: null, commitmentMonths: months || null,
            note: `Barème initial issu de la proposition ${p.number} (PricingSnapshot ${snapshot.sha256.slice(0, 12)}…).`,
            createdByUserId: p.ownerUserId, createdAt: now, updatedAt: now,
          },
        });
        await tx.pricingLine.createMany({
          data: sched.lines.map((l: EngineLine, i: number) => {
            const ix = indexed.get(l.id);
            const params: Record<string, unknown> = {};
            if (l.discount) params.discount = l.discount;
            if (ix && (l.kind === 'UNIT' || l.kind === 'FLAT_MONTHLY')) {
              // Révision annuelle Syntec à la date anniversaire (brief §12.11).
              params.revision = {
                indexCode: 'SYNTEC', a: String(ix.a), b: String(ix.b),
                referenceDate: validFrom, revisionDate: iso(addMonths(new Date(`${validFrom}T00:00:00Z`), 12)),
              };
            }
            return {
              id: uuidv7(), tenantId, customerId, scheduleId, lineKey: l.id, sortOrder: i, articleCode: l.code,
              label: l.label, unit: l.unit, kind: l.kind, mode: l.mode, recurrence: l.recurrence ?? null,
              vatRatePercent: l.vatRatePercent, quantitySource: 'FIXED' as const,
              quantity: l.kind === 'DISCOUNT' ? null : l.quantity && l.quantity.source === 'FIXED' ? l.quantity.value : '1',
              providerArticleCode: null, unitPrice: l.unitPrice ?? null, params: params as object,
            };
          }),
        });
        if (asContract) {
          await tx.pricingSchedule.update({ where: { id: scheduleId }, data: { status: 'ACTIVE', activatedAt: now, activatedByUserId: null } });
        }

        // Texte : contrat type publié (clauses copiées, annexes, variables), sinon version vide.
        if (templateVersionId) {
          await this.structure.initializeFromTemplate(tx, id, templateVersionId, versionId, now, p.ownerUserId);
        } else {
          await tx.contractVersion.create({
            data: { id: versionId, tenantId, customerId, contractId: id, versionNumber: 1, bodyHtml: '', variables: {}, createdAt: now, createdByUserId: p.ownerUserId },
          });
        }

        // Signataires côté client : les destinataires signataires de la proposition.
        const signers = await tx.proposalRecipient.findMany({ where: { proposalId, role: 'SIGNER' }, orderBy: { signingOrder: 'asc' } });
        if (signers.length) {
          await tx.contractSigner.createMany({
            data: signers.map((r: any, i: number) => ({
              id: uuidv7(), tenantId, customerId, contractId: id, party: 'CLIENT' as const, contactId: r.contactId,
              fullName: r.fullName, email: r.email, roleLabel: r.jobTitle, signingOrder: i,
              status: asContract ? ('SIGNED' as const) : ('PENDING' as const), signedAt: asContract ? signedAt : null,
              createdAt: now, updatedAt: now,
            })),
            skipDuplicates: true,
          });
        }

        if (asContract) {
          const c = await tx.contract.findUniqueOrThrow({ where: { id }, include: { customer: { select: { externalRef: true } } } });
          await publishContractTransition(tx, null, c, c.customer.externalRef ?? null, now);
        }
        await persistProposalTransition(tx, p.id, { type: 'CONVERT', contractId: id }, { now, extra: { contractId: id, conversionError: null } });
        notices.push(await this.notifier.record(tx, {
          tenantId, customerId, proposalId, recipientUserId: p.ownerUserId, recipientEmail: p.owner?.email ?? null,
          type: 'proposal.converted', subject: `${p.number} : contrat ${contract.reference} généré`,
          body: `La proposition ${p.number} a été convertie en contrat ${contract.reference} (${asContract ? 'actif' : 'brouillon à relire'}).`,
          dedupKey: `converted:${p.id}`,
        }, now));
        return { contractId: id, created: true };
      });
      await this.notifier.flush(notices);
      return out;
    } catch (e) {
      // Course : un autre processus a créé le contrat (contracts_proposal_key). La
      // transaction est annulée ; on relit hors transaction et on renvoie l'existant.
      if ((e as { code?: string }).code === 'P2002') {
        const again = await withScope(scope, (tx) => tx.contract.findUnique({ where: { proposalId }, select: { id: true } }));
        if (again) return { contractId: again.id, created: false };
      }
      if (e instanceof ConversionError) {
        await this.recordFailure(tenantId, customerId, proposalId, e, now);
        throw new ConflictException({ code: e.code, detail: e.message });
      }
      throw e;
    }
  }

  private async recordFailure(tenantId: string, customerId: string, proposalId: string, e: ConversionError, now: Date) {
    if (e.code === 'NOT_SIGNED' || e.code === 'NOT_FOUND') return;
    const notices: (ProposalNotice | null)[] = [];
    await withScope(systemScope(tenantId, customerId), async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id: proposalId }, include: { owner: { select: { email: true } } } });
      if (!p) return;
      await tx.proposal.update({ where: { id: proposalId }, data: { conversionError: e.message, updatedAt: now } });
      notices.push(await this.notifier.record(tx, {
        tenantId, customerId, proposalId, recipientUserId: p.ownerUserId, recipientEmail: p.owner?.email ?? null,
        type: 'proposal.conversion_failed', subject: `${p.number} : conversion en contrat impossible`, body: e.message,
        dedupKey: `conversion-failed:${proposalId}:${parisDay(now)}`,
      }, now));
    });
    await this.notifier.flush(notices);
    this.log.warn(`conversion de ${proposalId} impossible : ${e.message}`);
  }
}
