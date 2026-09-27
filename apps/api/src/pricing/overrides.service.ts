import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { D, overrideGapPercent, validateOverride } from '@lsi/pricing';
import { PricingEvents } from './pricing-events.js';
import { dayToDate, decOrNull, isoDay, type OverrideRow, type Tx } from './pricing-snapshot.js';
import type { CreateOverride } from './pricing.schemas.js';
import { PricingService } from './pricing.service.js';

/**
 * Dérogations tarifaires et double validation (brief §5 mode 3 ; 04 §8, §17.3).
 *
 * Création :
 *  - motif obligatoire, période bornée, prix décimal (validateOverride du
 *    moteur — mêmes règles qu'au calcul) ;
 *  - la ligne visée doit exister dans la version applicable à `validFrom`
 *    (on déroge à un prix qui existe) ;
 *  - écart = |prix dérogé − prix calculé à validFrom| / prix calculé, avec le
 *    seuil du tenant `pricing.overrideApprovalThresholdPercent` (défaut 10 %,
 *    comparaison STRICTE, V2-H19). Au-delà : PENDING_APPROVAL ; sinon ACTIVE.
 *
 * Validation : un utilisateur DISTINCT de l'auteur, avec le droit
 * `pricing.override.approve`. Le contrôle est fait ici (403 lisible) ET en base
 * (CHECK approved_by_user_id <> author_user_id) : aucun chemin d'écriture ne
 * permet l'auto-validation.
 *
 * Au calcul, le moteur RÉÉVALUE l'écart à chaque date : une dérogation ACTIVE
 * sans validateur dont l'écart dépasse le seuil après une révision est
 * écartée (trace REQUIRES_SECOND_APPROVAL) — elle peut alors être validée.
 * Une dérogation PENDING_APPROVAL n'est JAMAIS appliquée (PricingService).
 */

export interface OverrideView {
  id: string;
  lineKey: string;
  unitPrice: string;
  validFrom: string;
  validTo: string;
  reason: string;
  computedUnitPrice: string | null;
  gapPercent: string | null;
  requiresSecondApproval: boolean;
  status: string;
  authorUserId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  rejectedByUserId: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

function view(o: OverrideRow): OverrideView {
  return {
    id: o.id,
    lineKey: o.lineKey,
    unitPrice: o.unitPrice.toFixed(),
    validFrom: isoDay(o.validFrom),
    validTo: isoDay(o.validTo),
    reason: o.reason,
    computedUnitPrice: decOrNull(o.computedUnitPrice),
    gapPercent: decOrNull(o.gapPercent),
    requiresSecondApproval: o.requiresSecondApproval,
    status: o.status,
    authorUserId: o.authorUserId,
    approvedByUserId: o.approvedByUserId,
    approvedAt: o.approvedAt,
    rejectedByUserId: o.rejectedByUserId,
    rejectedAt: o.rejectedAt,
    rejectionReason: o.rejectionReason,
    cancelledByUserId: o.cancelledByUserId,
    cancelledAt: o.cancelledAt,
    createdAt: o.createdAt,
  };
}

/** Plafond de la colonne gap_percent (numeric(14,4)) : au-delà, écart « infini ». */
const GAP_MAX = D('9999999999');

@Injectable()
export class PriceOverridesService {
  constructor(
    private readonly pricing: PricingService,
    private readonly events: PricingEvents,
  ) {}

  async list(scope: Scope, contractId: string): Promise<{ items: OverrideView[] }> {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const rows = await tx.priceOverride.findMany({ where: { contractId }, orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }] });
      return { items: rows.map(view) };
    });
  }

  async create(scope: Scope, contractId: string, body: CreateOverride, now: Date): Promise<OverrideView> {
    const author = userOf(scope);
    const issues = validateOverride({
      id: 'new', lineId: body.lineKey, unitPrice: body.unitPrice, validFrom: body.validFrom, validTo: body.validTo,
      reason: body.reason, authorId: author, approvedBy: null,
    });
    if (issues.length) {
      throw new UnprocessableEntityException({ code: 'INVALID_OVERRIDE', message: issues.map((i) => i.message), issues });
    }

    // Prix calculé de référence, hors dérogation, à la date d'effet (404 si
    // la ligne n'existe pas à cette date, 404/409/422 du moteur sinon).
    const computed = await this.pricing.computedUnitPrice(scope, contractId, body.lineKey, body.validFrom);
    const settings = await this.pricing.engineSettings(scope);
    const gap = overrideGapPercent(D(body.unitPrice), D(computed));
    const requires = gap === null || gap.gt(D(settings.overrideApprovalThresholdPercent));

    const row = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { tenantId: true, customerId: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      return tx.priceOverride.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId,
          lineKey: body.lineKey, unitPrice: body.unitPrice,
          validFrom: dayToDate(body.validFrom), validTo: dayToDate(body.validTo), reason: body.reason,
          computedUnitPrice: computed,
          gapPercent: gap === null || gap.gte(GAP_MAX) ? null : gap.toDecimalPlaces(4).toFixed(),
          requiresSecondApproval: requires,
          status: requires ? 'PENDING_APPROVAL' : 'ACTIVE',
          authorUserId: author, createdAt: now, updatedAt: now,
        },
      });
    });
    if (row.status === 'ACTIVE') await this.revised(scope, row, 'OVERRIDE_EFFECTIVE', now);
    return view(row);
  }

  /**
   * Seconde validation. Admissible sur une dérogation EN ATTENTE, ou ACTIVE
   * sans validateur (écart devenu supérieur au seuil après une révision).
   * Mise à jour CONDITIONNELLE (updateMany sur l'état attendu) : deux
   * validations concurrentes → une seule gagne, l'autre reçoit 409.
   */
  async approve(scope: Scope, contractId: string, overrideId: string, now: Date): Promise<OverrideView> {
    const approver = userOf(scope);
    const row = await withScope(scope, async (tx) => {
      const o = await this.findOrThrow(tx, contractId, overrideId);
      if (o.authorUserId === approver) {
        throw new ForbiddenException('La seconde validation doit venir d’un autre utilisateur que l’auteur de la dérogation.');
      }
      const eligible = o.status === 'PENDING_APPROVAL' || (o.status === 'ACTIVE' && o.approvedByUserId === null);
      if (!eligible) throw new ConflictException({ code: 'OVERRIDE_NOT_PENDING', message: `Dérogation ${o.status} : rien à valider.` });
      const r = await tx.priceOverride.updateMany({
        where: { id: o.id, status: o.status, approvedByUserId: null },
        data: { status: 'ACTIVE', approvedByUserId: approver, approvedAt: now, updatedAt: now },
      });
      if (r.count !== 1) throw new ConflictException('Dérogation modifiée entre-temps : recharger.');
      return tx.priceOverride.findUniqueOrThrow({ where: { id: o.id } });
    });
    await this.revised(scope, row, 'OVERRIDE_EFFECTIVE', now);
    return view(row);
  }

  async reject(scope: Scope, contractId: string, overrideId: string, reason: string, now: Date): Promise<OverrideView> {
    const rejecter = userOf(scope);
    return view(
      await withScope(scope, async (tx) => {
        const o = await this.findOrThrow(tx, contractId, overrideId);
        if (o.authorUserId === rejecter) {
          throw new ForbiddenException('L’auteur ne statue pas sur sa propre dérogation : l’annuler plutôt.');
        }
        const r = await tx.priceOverride.updateMany({
          where: { id: o.id, status: 'PENDING_APPROVAL' },
          data: { status: 'REJECTED', rejectedByUserId: rejecter, rejectedAt: now, rejectionReason: reason, updatedAt: now },
        });
        if (r.count !== 1) throw new ConflictException({ code: 'OVERRIDE_NOT_PENDING', message: `Dérogation ${o.status} : rien à refuser.` });
        return tx.priceOverride.findUniqueOrThrow({ where: { id: o.id } });
      }),
    );
  }

  async cancel(scope: Scope, contractId: string, overrideId: string, now: Date): Promise<OverrideView> {
    const user = userOf(scope);
    let wasActive = false;
    const row = await withScope(scope, async (tx) => {
      const o = await this.findOrThrow(tx, contractId, overrideId);
      wasActive = o.status === 'ACTIVE';
      const r = await tx.priceOverride.updateMany({
        where: { id: o.id, status: { in: ['PENDING_APPROVAL', 'ACTIVE'] } },
        data: { status: 'CANCELLED', cancelledByUserId: user, cancelledAt: now, updatedAt: now },
      });
      if (r.count !== 1) throw new ConflictException({ code: 'OVERRIDE_CLOSED', message: `Dérogation ${o.status} : déjà close.` });
      return tx.priceOverride.findUniqueOrThrow({ where: { id: o.id } });
    });
    if (wasActive) await this.revised(scope, row, 'OVERRIDE_CANCELLED', now);
    return view(row);
  }

  private async findOrThrow(tx: Tx, contractId: string, overrideId: string) {
    const o = await tx.priceOverride.findFirst({ where: { id: overrideId, contractId } });
    if (!o) throw new NotFoundException('Dérogation introuvable');
    return o;
  }

  private revised(scope: Scope, o: OverrideRow, cause: 'OVERRIDE_EFFECTIVE' | 'OVERRIDE_CANCELLED', now: Date) {
    const today = now.toISOString().slice(0, 10);
    const from = isoDay(o.validFrom);
    return this.events.publish({
      type: 'pricing.revised',
      tenantId: o.tenantId,
      customerId: o.customerId,
      contractId: o.contractId,
      cause,
      // Le changement vaut pour l'avenir : jamais avant aujourd'hui.
      effectiveFrom: from < today ? today : from,
      overrideId: o.id,
      actorUserId: userOf(scope),
      occurredAt: now.toISOString(),
    });
  }
}

function userOf(scope: Scope): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.userId)) {
    throw new ForbiddenException('Action réservée à un utilisateur identifié.');
  }
  return scope.userId;
}
