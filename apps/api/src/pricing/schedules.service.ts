import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { PricingError, priceAt, type PricingInput, type ResolvedQuantity } from '@lsi/pricing';
import { DeadlinesService } from '../deadlines/deadlines.service.js';
import { STRUCTURAL_ERRORS, toHttp } from './pricing-errors.js';
import { PricingEvents } from './pricing-events.js';
import {
  dayToDate,
  isoDay,
  lineParams,
  loadIndexes,
  loadRuleCatalog,
  referencedIndexCodes,
  toEngineSchedule,
  type LineRow,
  type ScheduleWithLines,
  type Tx,
} from './pricing-snapshot.js';
import type { CreateSchedule, LineInput, UpdateSchedule } from './pricing.schemas.js';
import { PricingService } from './pricing.service.js';

/**
 * Versions du barème d'un contrat (04-tarification.md §3.1, §17.2).
 *
 * Cycle : DRAFT (librement modifiable) → ACTIVE (figée) → SUPERSEDED (figée,
 * clôturée par la version suivante). « Réviser » = créer une version, jamais
 * modifier une version active — la base le garantit (trigger), ce service
 * n'en est que le chemin nominal.
 *
 * Activation, en UNE transaction :
 *  1. le moteur calcule la nouvelle version à sa date d'effet : une erreur
 *     STRUCTURELLE (ligne, formule, révision, remise, règle absente) refuse
 *     l'activation (422) — on n'engage pas un barème incalculable ;
 *  2. les versions engagées antérieures qui la chevauchent sont clôturées la
 *     veille (SUPERSEDED) ; une version engagée qui commence le même jour ou
 *     après refuse l'activation (409) : on ne réécrit pas l'avenir engagé ;
 *  3. la contrainte d'exclusion de la base tranche les courses (deux
 *     activations concurrentes) : l'une échoue, la transaction est annulée
 *     ENTIÈRE, l'erreur est traduite en 409 hors transaction.
 * Puis, après commit : `pricing.revised` et recalcul de l'échéancier.
 */

export interface ScheduleView {
  id: string;
  version: number;
  status: string;
  validFrom: string;
  validTo: string | null;
  currency: string;
  commitmentMonths: number | null;
  note: string | null;
  createdByUserId: string;
  activatedByUserId: string | null;
  activatedAt: Date | null;
  lines: LineView[];
}

export interface LineView extends LineInput {
  sortOrder: number;
}

const PG_EXCLUSION = /pricing_schedules_no_overlap|23P01/;
const PG_UNIQUE_VERSION = /pricing_schedules_version_key|P2002/;

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function lineView(l: LineRow): LineView {
  const p = lineParams(l.params);
  return {
    lineKey: l.lineKey,
    sortOrder: l.sortOrder,
    articleCode: l.articleCode,
    label: l.label,
    unit: l.unit,
    kind: l.kind,
    mode: l.mode,
    recurrence: l.recurrence,
    vatRatePercent: l.vatRatePercent.toFixed(),
    quantitySource: l.quantitySource,
    ...(l.quantity != null ? { quantity: l.quantity.toFixed() } : {}),
    ...(l.providerArticleCode ? { providerArticleCode: l.providerArticleCode } : {}),
    ...(l.unitPrice != null ? { unitPrice: l.unitPrice.toFixed() } : {}),
    ...(p as object),
  } as LineView;
}

function scheduleView(s: ScheduleWithLines): ScheduleView {
  return {
    id: s.id,
    version: s.versionNumber,
    status: s.status,
    validFrom: isoDay(s.validFrom),
    validTo: s.validTo ? isoDay(s.validTo) : null,
    currency: s.currency,
    commitmentMonths: s.commitmentMonths,
    note: s.note,
    createdByUserId: s.createdByUserId,
    activatedByUserId: s.activatedByUserId,
    activatedAt: s.activatedAt,
    lines: [...s.lines].sort((a, b) => a.sortOrder - b.sortOrder).map(lineView),
  };
}

@Injectable()
export class PricingSchedulesService {
  private readonly log = new Logger(PricingSchedulesService.name);

  constructor(
    private readonly pricing: PricingService,
    private readonly deadlines: DeadlinesService,
    private readonly events: PricingEvents,
  ) {}

  async list(scope: Scope, contractId: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.contractOrThrow(tx, contractId);
      const rows = await tx.pricingSchedule.findMany({ where: { contractId }, include: { lines: true }, orderBy: { versionNumber: 'asc' } });
      const next = await this.pricing.nextRevisionDate(tx, contractId, now);
      return { items: rows.map(scheduleView), nextRevisionDate: next ? isoDay(next) : null };
    });
  }

  async createDraft(scope: Scope, contractId: string, body: CreateSchedule, now: Date): Promise<ScheduleView> {
    try {
      return await withScope(scope, async (tx) => {
        const contract = await this.contractOrThrow(tx, contractId);
        const last = await tx.pricingSchedule.findFirst({ where: { contractId }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } });
        let lines: LineInput[];
        if (body.copyFromVersion !== undefined) {
          const src = await tx.pricingSchedule.findUnique({
            where: { contractId_versionNumber: { contractId, versionNumber: body.copyFromVersion } },
            include: { lines: true },
          });
          if (!src) throw new NotFoundException(`Version ${body.copyFromVersion} introuvable`);
          lines = [...src.lines].sort((a, b) => a.sortOrder - b.sortOrder).map(lineView);
        } else {
          lines = body.lines ?? [];
        }
        const id = uuidv7();
        await tx.pricingSchedule.create({
          data: {
            id, tenantId: contract.tenantId, customerId: contract.customerId, contractId,
            versionNumber: (last?.versionNumber ?? 0) + 1, status: 'DRAFT',
            validFrom: dayToDate(body.validFrom), validTo: body.validTo ? dayToDate(body.validTo) : null,
            commitmentMonths: body.commitmentMonths ?? null, note: body.note ?? null,
            createdByUserId: actor(scope), createdAt: now, updatedAt: now,
          },
        });
        await this.insertLines(tx, contract, id, lines);
        return this.viewOf(tx, id);
      });
    } catch (e) {
      // Deux brouillons créés au même instant : même numéro de version. La
      // transaction a été ANNULÉE (pas de reprise à l'intérieur, 25P02) ;
      // on le dit, l'appelant rejoue.
      if (PG_UNIQUE_VERSION.test(String((e as Error).message)) || (e as { code?: string }).code === 'P2002') {
        throw new ConflictException('Une autre version vient d’être créée : réessayer.');
      }
      throw e;
    }
  }

  async updateDraft(scope: Scope, contractId: string, version: number, body: UpdateSchedule, now: Date): Promise<ScheduleView> {
    return withScope(scope, async (tx) => {
      const contract = await this.contractOrThrow(tx, contractId);
      const s = await this.draftOrThrow(tx, contractId, version);
      await tx.pricingSchedule.update({
        where: { id: s.id },
        data: {
          validFrom: dayToDate(body.validFrom), validTo: body.validTo ? dayToDate(body.validTo) : null,
          commitmentMonths: body.commitmentMonths ?? null, note: body.note ?? null, updatedAt: now,
        },
      });
      await tx.pricingLine.deleteMany({ where: { scheduleId: s.id } });
      await this.insertLines(tx, contract, s.id, body.lines);
      return this.viewOf(tx, s.id);
    });
  }

  async deleteDraft(scope: Scope, contractId: string, version: number): Promise<{ deleted: number }> {
    return withScope(scope, async (tx) => {
      await this.contractOrThrow(tx, contractId);
      const s = await this.draftOrThrow(tx, contractId, version);
      await tx.pricingSchedule.delete({ where: { id: s.id } });
      return { deleted: version };
    });
  }

  async activate(scope: Scope, contractId: string, version: number, now: Date): Promise<ScheduleView> {
    const settings = await this.pricing.engineSettings(scope);
    let result: { view: ScheduleView; tenantId: string; customerId: string; closed: number[] };
    try {
      result = await withScope(scope, async (tx) => {
        const contract = await this.contractOrThrow(tx, contractId);
        const draft = await this.draftOrThrow(tx, contractId, version);
        await this.assertComputable(tx, draft, settings);

        const engaged = await tx.pricingSchedule.findMany({
          where: { contractId, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
          orderBy: { versionNumber: 'asc' },
        });
        const from = isoDay(draft.validFrom);
        const to = draft.validTo ? isoDay(draft.validTo) : null;
        const closed: number[] = [];
        for (const e of engaged) {
          const eFrom = isoDay(e.validFrom);
          const eTo = e.validTo ? isoDay(e.validTo) : null;
          const overlaps = eFrom <= (to ?? '9999-12-31') && from <= (eTo ?? '9999-12-31');
          if (!overlaps) continue;
          if (eFrom >= from) {
            throw new ConflictException({
              code: 'SCHEDULE_OVERLAP',
              message: `La version ${e.versionNumber} (engagée à partir du ${eFrom}) couvre déjà cette période : une version ne s’active qu’APRÈS les versions engagées.`,
            });
          }
          await tx.pricingSchedule.update({
            where: { id: e.id },
            data: { status: 'SUPERSEDED', validTo: dayToDate(previousDay(from)), supersededAt: now, updatedAt: now },
          });
          closed.push(e.versionNumber);
        }
        await tx.pricingSchedule.update({
          where: { id: draft.id },
          data: { status: 'ACTIVE', activatedAt: now, activatedByUserId: actor(scope), updatedAt: now },
        });
        return { view: await this.viewOf(tx, draft.id), tenantId: contract.tenantId, customerId: contract.customerId, closed };
      });
    } catch (e) {
      if (PG_EXCLUSION.test(String((e as Error).message))) {
        throw new ConflictException({ code: 'SCHEDULE_OVERLAP', message: 'Une autre version engagée couvre cette période (activation concurrente ?).' });
      }
      throw e;
    }

    await this.events.publish({
      type: 'pricing.revised',
      tenantId: result.tenantId,
      customerId: result.customerId,
      contractId,
      cause: 'SCHEDULE_ACTIVATED',
      effectiveFrom: result.view.validFrom,
      scheduleId: result.view.id,
      scheduleVersion: result.view.version,
      actorUserId: isUuid(scope.userId) ? scope.userId : null,
      occurredAt: now.toISOString(),
    });
    try {
      // La prochaine révision a pu changer : l'échéancier suit.
      await this.deadlines.recomputeInScope(scope, contractId, now);
    } catch (err) {
      this.log.error(`échéancier non recalculé après activation (${contractId}) : ${(err as Error).message}`);
    }
    return result.view;
  }

  // -------------------------------------------------------------------------

  /**
   * Rejoue le moteur sur la version seule, à sa date d'effet. Les quantités
   * fournies (PROVIDER) sont remplacées par « 1 » : on vérifie la STRUCTURE,
   * pas une mesure du jour ; une valeur d'indice ou une quantité manquante
   * n'empêche pas d'engager (elle empêchera le calcul, avec son code).
   */
  private async assertComputable(tx: Tx, draft: ScheduleWithLines, settings: PricingInput['settings']): Promise<void> {
    const schedule = toEngineSchedule(draft);
    if (schedule.lines.length === 0) {
      throw new UnprocessableEntityException({ code: 'EMPTY_SCHEDULE', message: 'Une version sans ligne ne peut pas être activée.' });
    }
    const quantities: ResolvedQuantity[] = schedule.lines
      .filter((l) => l.quantity?.source === 'PROVIDER')
      .map((l) => ({ lineId: l.id, quantity: '1', source: 'activation-check', observedAt: null }));
    const input: PricingInput = {
      schedules: [schedule],
      indexes: await loadIndexes(tx, referencedIndexCodes([schedule])),
      ruleCatalog: await loadRuleCatalog(tx),
      settings,
      quantities,
      ...(draft.commitmentMonths ? { context: { commitmentMonths: draft.commitmentMonths } } : {}),
    };
    try {
      priceAt(input, schedule.validFrom);
    } catch (e) {
      if (e instanceof PricingError && STRUCTURAL_ERRORS.has(e.code)) throw toHttp(e);
      if (!(e instanceof PricingError)) throw e;
    }
  }

  private async insertLines(tx: Tx, contract: { tenantId: string; customerId: string }, scheduleId: string, lines: readonly LineInput[]) {
    if (lines.length === 0) return;
    await tx.pricingLine.createMany({
      data: lines.map((l, i) => ({
        id: uuidv7(),
        tenantId: contract.tenantId,
        customerId: contract.customerId,
        scheduleId,
        lineKey: l.lineKey,
        sortOrder: (l as Partial<LineView>).sortOrder ?? i,
        articleCode: l.articleCode,
        label: l.label,
        unit: l.unit,
        kind: l.kind,
        mode: l.mode,
        recurrence: l.recurrence ?? null,
        vatRatePercent: l.vatRatePercent,
        quantitySource: l.quantitySource,
        quantity: l.kind === 'DISCOUNT' || l.quantitySource === 'PROVIDER' ? null : (l.quantity ?? '1'),
        providerArticleCode: l.providerArticleCode ?? null,
        unitPrice: l.unitPrice ?? null,
        params: paramsOf(l) as never,
      })),
    });
  }

  private async viewOf(tx: Tx, id: string): Promise<ScheduleView> {
    const s = await tx.pricingSchedule.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    return scheduleView(s);
  }

  private async contractOrThrow(tx: Tx, contractId: string) {
    const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true, tenantId: true, customerId: true } });
    if (!c) throw new NotFoundException('Contrat introuvable');
    return c;
  }

  private async draftOrThrow(tx: Tx, contractId: string, version: number) {
    const s = await tx.pricingSchedule.findUnique({
      where: { contractId_versionNumber: { contractId, versionNumber: version } },
      include: { lines: true },
    });
    if (!s) throw new NotFoundException(`Version ${version} du barème introuvable`);
    if (s.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'SCHEDULE_NOT_DRAFT',
        message: `La version ${version} est ${s.status} : une version engagée ne se modifie pas, créer une nouvelle version.`,
      });
    }
    return s;
  }
}

function paramsOf(l: LineInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['tiers', 'rule', 'formula', 'revision', 'hourPack', 'discount'] as const) {
    if (l[k] !== undefined) out[k] = l[k];
  }
  return out;
}

function previousDay(day: string): string {
  const d = dayToDate(day);
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDay(d);
}

function actor(scope: Scope): string {
  if (!isUuid(scope.userId)) throw new ConflictException('Action réservée à un utilisateur identifié.');
  return scope.userId;
}
