import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import {
  priceAt,
  resolveQuantities,
  selectSchedule,
  simulate,
  toJsonSafe,
  type PricedLine,
  type PricingInput,
  type PricingLine,
  type PricingResult,
  type PricingSettings,
  type QuantityProvider,
  type ResolvedQuantity,
  type TraceStep,
} from '@lsi/pricing';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { mapPricingErrors } from './pricing-errors.js';
import {
  dayToDate,
  decOrNull,
  isoDay,
  lineParams,
  loadContractSnapshot,
  loadRuleCatalog,
  todayParis,
  type ContractSnapshot,
  type OverrideRow,
  type Tx,
} from './pricing-snapshot.js';
import type { QuoteBody, SimulateBody } from './pricing.schemas.js';
import { QUANTITY_PROVIDER } from './quantity-provider.js';

/**
 * `priceAt(contractId, date)` — la signature du brief (§5), côté application.
 *
 * Compose exactement le schéma de 04-tarification.md §2 :
 *   1. instantané chargé sous withScope (RLS tenant + client) ;
 *   2. quantités résolues par le QuantityProvider (E/S, HORS transaction) ;
 *   3. calcul PUR par @lsi/pricing ;
 *   4. sérialisation `toJsonSafe` : les totaux (bigint, centimes) deviennent
 *      des chaînes (« 128867 »), jamais des nombres JSON.
 *
 * Aucune règle de prix ici : le service CHARGE et TRADUIT. Le prix affiché,
 * simulé, coté ou révisé est celui du moteur, au centime et à la trace près.
 *
 * Dérogations EN ATTENTE de seconde validation : jamais transmises au moteur
 * (donc jamais appliquées, même si l'écart retombait sous le seuil à la date
 * — la décision de les soumettre à validation a été prise, elle attend son
 * validateur), mais SIGNALÉES dans la trace de la ligne (`OVERRIDE_SKIPPED`,
 * `REQUIRES_SECOND_APPROVAL`) et dans `pendingOverrides`.
 */

export interface PriceAtOptions {
  readonly trace?: boolean;
  readonly version?: number;
}

type JsonLine = Omit<ReturnType<typeof toJsonSafe<PricedLine>>, 'trace'> & { trace?: unknown };

const fixedPercent = (n: number): string => n.toFixed(4).replace(/\.?0+$/, '') || '0';

@Injectable()
export class PricingService {
  constructor(
    private readonly config: TenantConfigService,
    @Inject(QUANTITY_PROVIDER) private readonly quantities: QuantityProvider,
  ) {}

  /** Paramètres `pricing.*` du tenant, au format du moteur. */
  async engineSettings(scope: Scope): Promise<PricingSettings> {
    const s = await this.config.settings(scope);
    return {
      rounding: s['pricing.rounding'] as PricingSettings['rounding'],
      unitPriceScale: s['pricing.unitPriceScale'] as number,
      indexLookup: s['pricing.indexLookup'] as PricingSettings['indexLookup'],
      overrideApprovalThresholdPercent: fixedPercent(s['pricing.overrideApprovalThresholdPercent'] as number),
    };
  }

  // -------------------------------------------------------------------------
  // Chargement + quantités
  // -------------------------------------------------------------------------

  /** Instantané + entrée du moteur (quantités non résolues). */
  async snapshot(scope: Scope, contractId: string, version?: number): Promise<{ snap: ContractSnapshot; input: PricingInput }> {
    const settings = await this.engineSettings(scope);
    const snap = await withScope(scope, (tx) => loadContractSnapshot(tx, contractId, version === undefined ? {} : { version }));
    const input: PricingInput = {
      schedules: snap.engineSchedules,
      indexes: snap.indexes,
      overrides: snap.overrides,
      ruleCatalog: snap.ruleCatalog,
      settings,
    };
    return { snap, input };
  }

  /** Contexte (durée d'engagement) de la version applicable à `date`. */
  private withContext(snap: ContractSnapshot, input: PricingInput, date: string): PricingInput {
    let commitmentMonths: number | null | undefined;
    try {
      const s = selectSchedule(input.schedules, date);
      commitmentMonths = snap.schedules.find((x) => x.id === s.id)?.commitmentMonths;
    } catch {
      // Pas de version à la date : priceAt lèvera NO_SCHEDULE, avec son message.
    }
    return commitmentMonths ? { ...input, context: { commitmentMonths } } : input;
  }

  private async resolve(input: PricingInput, contractId: string, dates: readonly string[]): Promise<ResolvedQuantity[]> {
    const byLine = new Map<string, ResolvedQuantity>();
    for (const date of [...new Set(dates)]) {
      let qs: ResolvedQuantity[];
      try {
        qs = await resolveQuantities(input, contractId, date, this.quantities);
      } catch (e) {
        // Pas de version à cette date : c'est priceAt qui le dira (NO_SCHEDULE).
        if ((e as { code?: string }).code === 'NO_SCHEDULE') continue;
        throw e;
      }
      for (const q of qs) byLine.set(q.lineId, q);
    }
    return [...byLine.values()];
  }

  // -------------------------------------------------------------------------
  // priceAt
  // -------------------------------------------------------------------------

  /** Barème du contrat à la date (JSON sûr : centimes en chaînes). */
  async priceAt(scope: Scope, contractId: string, date: string, opts: PriceAtOptions = {}) {
    return mapPricingErrors(async () => {
      const { snap, input } = await this.snapshot(scope, contractId, opts.version);
      const quantities = await this.resolve(input, contractId, [date]);
      const result = priceAt({ ...this.withContext(snap, input, date), quantities }, date);
      return this.present(snap, annotatePending(result, snap.pendingOverrides, date), opts.trace ?? false);
    });
  }

  /** Prix unitaire calculé d'une ligne, SANS dérogation (référence de l'écart). */
  async computedUnitPrice(scope: Scope, contractId: string, lineKey: string, date: string): Promise<string> {
    return mapPricingErrors(async () => {
      const { snap, input } = await this.snapshot(scope, contractId);
      const quantities = await this.resolve(input, contractId, [date]);
      const result = priceAt({ ...this.withContext(snap, input, date), overrides: [], quantities }, date);
      const line = result.lines.find((l) => l.lineId === lineKey);
      if (!line) {
        throw new NotFoundException(`La ligne « ${lineKey} » n’existe pas dans la version du barème applicable au ${date}.`);
      }
      return line.unitPrice;
    });
  }

  private present(snap: ContractSnapshot, result: PricingResult, trace: boolean) {
    const json = toJsonSafe(result);
    const version = snap.schedules.find((s) => s.id === result.scheduleId)?.versionNumber ?? null;
    const lines: JsonLine[] = trace ? json.lines : json.lines.map(({ trace: _t, ...l }) => l);
    return {
      contractId: snap.contract.id,
      ...json,
      scheduleVersion: version,
      lines,
      pendingOverrides: snap.pendingOverrides
        .filter((o) => isoDay(o.validFrom) <= result.date && result.date <= isoDay(o.validTo))
        .map((o) => ({ id: o.id, lineId: o.lineKey, unitPrice: o.unitPrice.toFixed(), reason: o.reason, authorUserId: o.authorUserId })),
    };
  }

  // -------------------------------------------------------------------------
  // Simulateur
  // -------------------------------------------------------------------------

  async simulate(scope: Scope, contractId: string, body: SimulateBody) {
    return mapPricingErrors(async () => {
      const { snap, input } = await this.snapshot(scope, contractId);
      const dates = body.beforeDate ? [body.beforeDate, body.at] : [body.at];
      const quantities = await this.resolve(input, contractId, dates);
      const r = simulate({ ...this.withContext(snap, input, body.at), quantities }, body.at, body.changes, body.beforeDate ? { beforeDate: body.beforeDate } : {});
      const json = toJsonSafe(r);
      const strip = <T extends { lines: { trace?: unknown }[] }>(x: T): T =>
        body.trace ? x : { ...x, lines: x.lines.map(({ trace: _t, ...l }) => l) };
      return { contractId, ...json, before: strip(json.before), after: strip(json.after) };
    });
  }

  // -------------------------------------------------------------------------
  // Devis (futur POST /api/v1/pricing/quote)
  // -------------------------------------------------------------------------

  /**
   * Prix d'un article, d'une quantité, à une date, pour un contrat ou un client :
   *  1. le barème du contrat fait foi s'il porte l'article (révision et
   *     dérogations comprises) — contrat désigné, ou UNIQUE contrat du client
   *     portant l'article à la date (plusieurs → 409, préciser `contractId`) ;
   *  2. sinon, la grille du catalogue du tenant (règle GRID portant l'article ;
   *     plusieurs → 409, préciser `ruleCode`).
   * Barème éphémère d'une ligne, puis le MÊME priceAt.
   */
  async quote(scope: Scope, body: QuoteBody) {
    const date = body.date ?? todayParis();
    return mapPricingErrors(async () => {
      const contractId = body.contractId ?? (body.customerId ? await this.contractForArticle(scope, body.customerId, body.articleCode, date) : null);
      if (contractId) {
        const fromContract = await this.quoteFromContract(scope, contractId, body, date);
        if (fromContract) return fromContract;
      }
      return this.quoteFromCatalog(scope, body, date);
    });
  }

  private async contractForArticle(scope: Scope, customerId: string, articleCode: string, date: string): Promise<string | null> {
    return withScope(scope, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) throw new NotFoundException('Client introuvable');
      const day = dayToDate(date);
      const rows = await tx.pricingSchedule.findMany({
        where: {
          customerId,
          status: { in: ['ACTIVE', 'SUPERSEDED'] },
          validFrom: { lte: day },
          OR: [{ validTo: null }, { validTo: { gte: day } }],
          lines: { some: { articleCode } },
        },
        select: { contractId: true },
      });
      const ids = [...new Set(rows.map((r) => r.contractId))];
      if (ids.length > 1) {
        throw new ConflictException({
          code: 'QUOTE_AMBIGUOUS',
          message: `Plusieurs contrats du client portent l’article « ${articleCode} » au ${date} : préciser contractId.`,
          contractIds: ids,
        });
      }
      return ids[0] ?? null;
    });
  }

  private async quoteFromContract(scope: Scope, contractId: string, body: QuoteBody, date: string) {
    const { snap, input } = await this.snapshot(scope, contractId);
    let schedule;
    try {
      schedule = selectSchedule(input.schedules, date);
    } catch {
      return null; // aucun barème à la date : le catalogue s'applique
    }
    const candidates = schedule.lines.filter((l) => l.code === body.articleCode && l.kind !== 'DISCOUNT');
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      throw new ConflictException({
        code: 'QUOTE_AMBIGUOUS',
        message: `Le barème porte plusieurs lignes pour l’article « ${body.articleCode} ».`,
        lineIds: candidates.map((l) => l.id),
      });
    }
    const line: PricingLine = { ...(candidates[0] as PricingLine), quantity: { source: 'FIXED', value: body.quantity } };
    const quoteInput: PricingInput = {
      ...this.withContext(snap, input, date),
      schedules: [{ ...schedule, lines: [line] }],
      overrides: (input.overrides ?? []).filter((o) => o.lineId === line.id),
    };
    const result = annotatePending(priceAt(quoteInput, date), snap.pendingOverrides, date);
    const json = toJsonSafe(result);
    return {
      source: 'CONTRACT' as const,
      contractId,
      scheduleVersion: snap.schedules.find((s) => s.id === result.scheduleId)?.versionNumber ?? null,
      articleCode: body.articleCode,
      quantity: body.quantity,
      date,
      line: json.lines[0],
      totals: json.totals,
    };
  }

  private async quoteFromCatalog(scope: Scope, body: QuoteBody, date: string) {
    const settings = await this.engineSettings(scope);
    const { catalog, grids } = await withScope(scope, async (tx) => {
      const catalog = await loadRuleCatalog(tx);
      const grids = await tx.pricingRule.findMany({ where: { type: 'GRID', archivedAt: null }, select: { code: true, definition: true } });
      return { catalog, grids };
    });
    const holders = grids
      .filter((g) => ((g.definition as { entries?: { articleCode: string }[] }).entries ?? []).some((e) => e.articleCode === body.articleCode))
      .map((g) => g.code);
    const ruleCode = body.ruleCode ?? (holders.length === 1 ? holders[0] : undefined);
    if (!ruleCode) {
      if (holders.length === 0) throw new NotFoundException(`Aucune grille du catalogue ne porte l’article « ${body.articleCode} ».`);
      throw new ConflictException({
        code: 'QUOTE_AMBIGUOUS',
        message: `Plusieurs grilles portent l’article « ${body.articleCode} » : préciser ruleCode.`,
        ruleCodes: holders,
      });
    }
    const line: PricingLine = {
      id: 'quote',
      code: body.articleCode,
      label: body.articleCode,
      unit: 'unité',
      kind: 'UNIT',
      mode: 'RULE',
      // Hypothèse V2-H26 : TVA française au taux normal si non précisée.
      vatRatePercent: body.vatRatePercent ?? '20',
      quantity: { source: 'FIXED', value: body.quantity },
      rule: { priceRuleId: ruleCode },
    };
    const result = priceAt(
      { schedules: [{ id: 'quote', validFrom: date, validTo: date, currency: 'EUR', lines: [line] }], ruleCatalog: catalog, settings },
      date,
    );
    const json = toJsonSafe(result);
    return { source: 'CATALOG' as const, ruleCode, articleCode: body.articleCode, quantity: body.quantity, date, line: json.lines[0], totals: json.totals };
  }

  // -------------------------------------------------------------------------
  // Prochaine révision (échéancier)
  // -------------------------------------------------------------------------

  /**
   * Prochaine date de révision tarifaire d'un contrat, à partir de `from`
   * (jour inclus), dans la transaction scopée de l'appelant (DeadlinesService).
   *
   * Sources : les lignes à révision native (`revision.revisionDate`) des
   * versions ENGAGÉES encore en vigueur à `from` ou après.
   *  - une date de révision future (dans la validité de sa version) est une
   *    échéance ;
   *  - une date passée sur une version SANS FIN : la révision suivante est
   *    supposée ANNUELLE, à la date anniversaire (V2-H24) — la version qui la
   *    matérialisera n'existe pas encore, l'échéance rappelle de la créer.
   * La plus proche l'emporte ; aucune → null (pas d'échéance PRICE_REVISION).
   */
  async nextRevisionDate(tx: Tx, contractId: string, from: Date): Promise<Date | null> {
    const today = todayParis(from);
    const schedules = await tx.pricingSchedule.findMany({
      where: { contractId, status: { in: ['ACTIVE', 'SUPERSEDED'] }, OR: [{ validTo: null }, { validTo: { gte: dayToDate(today) } }] },
      include: { lines: { select: { params: true } } },
    });
    const candidates: string[] = [];
    for (const s of schedules) {
      const validFrom = isoDay(s.validFrom);
      const validTo = s.validTo ? isoDay(s.validTo) : null;
      for (const l of s.lines) {
        const rd = lineParams(l.params).revision?.revisionDate;
        if (!rd) continue;
        if (rd >= today && rd >= validFrom) {
          // Révision à venir, portée par cette version.
          if (validTo === null || rd <= validTo) candidates.push(rd);
        } else if (validTo === null) {
          // Révision passée (ou antérieure à la version) : anniversaire suivant,
          // postérieur au début de la version (qui matérialise la précédente).
          candidates.push(nextAnniversary(rd, today, validFrom));
        }
      }
    }
    if (candidates.length === 0) return null;
    return dayToDate(candidates.sort()[0] as string);
  }
}

/**
 * Première date anniversaire de `date` (même jour et mois, années suivantes)
 * qui soit ≥ `from` et, si fourni, STRICTEMENT après `after`.
 */
export function nextAnniversary(date: string, from: string, after?: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  for (let year = y + 1; ; year++) {
    // 29 février → 28 février les années non bissextiles.
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const candidate = `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    if (candidate >= from && (after === undefined || candidate > after)) return candidate;
  }
}

/**
 * Signale, dans la trace des lignes concernées, les dérogations en attente de
 * seconde validation couvrant la date — juste avant le total de ligne, là où
 * le moteur place ses propres `OVERRIDE_SKIPPED`.
 */
export function annotatePending(result: PricingResult, pending: readonly OverrideRow[], date: string): PricingResult {
  if (pending.length === 0) return result;
  const lines = result.lines.map((l) => {
    const hits = pending.filter((o) => o.lineKey === l.lineId && isoDay(o.validFrom) <= date && date <= isoDay(o.validTo));
    if (hits.length === 0) return l;
    const steps: TraceStep[] = hits.map((o) => ({
      type: 'OVERRIDE_SKIPPED',
      overrideId: o.id,
      reason: 'REQUIRES_SECOND_APPROVAL',
      gapPercent: decOrNull(o.gapPercent),
    }));
    const at = l.trace.findIndex((t) => t.type === 'LINE_TOTAL');
    const trace = at < 0 ? [...l.trace, ...steps] : [...l.trace.slice(0, at), ...steps, ...l.trace.slice(at)];
    return { ...l, trace };
  });
  return { ...result, lines };
}
