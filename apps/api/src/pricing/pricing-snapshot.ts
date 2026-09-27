import { NotFoundException } from '@nestjs/common';
import type { withScope } from '@lsi/persistence';
import type {
  PriceIndex as EngineIndex,
  PriceOverride as EngineOverride,
  PricingLine as EngineLine,
  PricingRule as EngineRule,
  PricingSchedule as EngineSchedule,
  RuleCatalog,
} from '@lsi/pricing';

/**
 * Chargement de l'INSTANTANÉ de tarification d'un contrat (04 §2, §13) :
 * la seule traduction base → moteur. Tout se lit dans UNE transaction
 * scopée (RLS tenant + client) : un contrat hors portée n'existe pas (404).
 *
 * Conversions, toutes explicites :
 *  - Decimal (Prisma) → chaîne via `toFixed()` : jamais via `number` ;
 *  - date SQL → « YYYY-MM-DD » (les colonnes `date` arrivent à minuit UTC) ;
 *  - `line_key` → `lineId` du moteur (clé STABLE entre versions : c'est elle
 *    que visent les dérogations) ;
 *  - `pricing_rules.code` → `id` de règle du moteur (RuleRef.priceRuleId).
 */

/** Client transactionnel de withScope, sans importer Prisma (§16.4-D). */
export type Tx = Parameters<Parameters<typeof withScope>[1]>[0];

type Dec = { toFixed(): string };
export const dec = (v: Dec): string => v.toFixed();
export const decOrNull = (v: Dec | null | undefined): string | null => (v == null ? null : v.toFixed());
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const dayToDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** Aujourd'hui, en jour calendaire de Paris (V2-H22 : conversion à la frontière). */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type ScheduleRow = Awaited<ReturnType<Tx['pricingSchedule']['findMany']>>[number];
export type LineRow = Awaited<ReturnType<Tx['pricingLine']['findMany']>>[number];
export type ScheduleWithLines = ScheduleRow & { lines: LineRow[] };
export type OverrideRow = Awaited<ReturnType<Tx['priceOverride']['findMany']>>[number];

/** Paramètres JSON d'une ligne : exactement les champs optionnels du moteur. */
export interface LineParams {
  tiers?: EngineLine['tiers'];
  rule?: EngineLine['rule'];
  formula?: EngineLine['formula'];
  revision?: EngineLine['revision'];
  hourPack?: EngineLine['hourPack'];
  discount?: EngineLine['discount'];
}
const PARAM_KEYS = ['tiers', 'rule', 'formula', 'revision', 'hourPack', 'discount'] as const;

export function lineParams(raw: unknown): LineParams {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PARAM_KEYS) if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return out as LineParams;
}

export function toEngineLine(l: LineRow): EngineLine {
  const params = lineParams(l.params);
  const line: Record<string, unknown> = {
    id: l.lineKey,
    code: l.articleCode,
    label: l.label,
    unit: l.unit,
    kind: l.kind,
    mode: l.mode,
    vatRatePercent: dec(l.vatRatePercent),
    ...params,
  };
  if (l.recurrence) line.recurrence = l.recurrence;
  if (l.unitPrice != null) line.unitPrice = dec(l.unitPrice);
  if (l.kind !== 'DISCOUNT') {
    line.quantity =
      l.quantitySource === 'PROVIDER'
        ? { source: 'PROVIDER', ...(l.providerArticleCode ? { articleCode: l.providerArticleCode } : {}) }
        : { source: 'FIXED', value: l.quantity == null ? '1' : dec(l.quantity) };
  }
  return line as unknown as EngineLine;
}

export function toEngineSchedule(s: ScheduleWithLines): EngineSchedule {
  return {
    id: s.id,
    validFrom: isoDay(s.validFrom),
    validTo: s.validTo ? isoDay(s.validTo) : null,
    currency: 'EUR',
    lines: [...s.lines].sort((a, b) => a.sortOrder - b.sortOrder || a.lineKey.localeCompare(b.lineKey)).map(toEngineLine),
  };
}

export function toEngineOverride(o: OverrideRow): EngineOverride {
  return {
    id: o.id,
    lineId: o.lineKey,
    unitPrice: dec(o.unitPrice),
    validFrom: isoDay(o.validFrom),
    validTo: isoDay(o.validTo),
    reason: o.reason,
    authorId: o.authorUserId,
    approvedBy: o.approvedByUserId,
  };
}

/** Codes d'indice référencés par un ensemble de barèmes (révision, formules). */
export function referencedIndexCodes(schedules: readonly EngineSchedule[]): string[] {
  const codes = new Set<string>();
  for (const s of schedules) {
    for (const l of s.lines) {
      if (l.revision) codes.add(l.revision.indexCode);
      for (const b of Object.values(l.formula?.indexVariables ?? {})) codes.add(b.indexCode);
    }
  }
  return [...codes].sort();
}

/**
 * Séries d'indices, réduites à la valeur COURANTE de chaque période : la
 * pointe de la chaîne de corrections (la ligne qu'aucune autre ne remplace).
 * Le moteur refuse deux valeurs pour une période (DUPLICATE_INDEX_VALUE) :
 * c'est ici, et nulle part ailleurs, que l'historique est replié.
 */
export async function loadIndexes(tx: Tx, codes: readonly string[]): Promise<EngineIndex[]> {
  if (codes.length === 0) return [];
  const rows = await tx.priceIndex.findMany({
    where: { code: { in: [...codes] } },
    include: { values: { orderBy: [{ period: 'asc' }, { revision: 'asc' }] } },
    orderBy: { code: 'asc' },
  });
  return rows.map((i) => ({ code: i.code, name: i.label, values: currentValues(i.values) }));
}

type ValueRow = { id: string; period: string; value: Dec; publishedAt: Date; supersedesId: string | null };
export function currentValues(values: readonly ValueRow[]): { period: string; value: string; publishedAt: string }[] {
  const superseded = new Set(values.map((v) => v.supersedesId).filter((x): x is string => x !== null));
  return values
    .filter((v) => !superseded.has(v.id))
    .map((v) => ({ period: v.period, value: dec(v.value), publishedAt: isoDay(v.publishedAt) }));
}

/** Catalogue de règles du tenant (archivées comprises : un barème actif peut encore les citer). */
export async function loadRuleCatalog(tx: Tx): Promise<RuleCatalog> {
  const rows = await tx.pricingRule.findMany({ orderBy: { code: 'asc' } });
  return {
    rules: rows.map((r) => ({ ...(r.definition as object), id: r.code, type: r.type, label: r.label }) as EngineRule),
  };
}

export interface ContractSnapshot {
  readonly contract: { id: string; tenantId: string; customerId: string; reference: string };
  /** Versions retenues pour le calcul (engagées, ou la seule version demandée). */
  readonly schedules: ScheduleWithLines[];
  readonly engineSchedules: EngineSchedule[];
  readonly indexes: EngineIndex[];
  readonly ruleCatalog: RuleCatalog;
  /** Dérogations APPLICABLES (ACTIVE) — transmises au moteur. */
  readonly overrides: EngineOverride[];
  /** Dérogations EN ATTENTE de seconde validation — jamais appliquées, signalées dans la trace. */
  readonly pendingOverrides: OverrideRow[];
}

export interface SnapshotOptions {
  /** Prévisualise UNE version (brouillon compris), seule. */
  readonly version?: number;
}

export async function loadContractSnapshot(tx: Tx, contractId: string, opts: SnapshotOptions = {}): Promise<ContractSnapshot> {
  const contract = await tx.contract.findUnique({
    where: { id: contractId },
    select: { id: true, tenantId: true, customerId: true, reference: true },
  });
  if (!contract) throw new NotFoundException('Contrat introuvable');

  const schedules = await tx.pricingSchedule.findMany({
    where:
      opts.version !== undefined
        ? { contractId, versionNumber: opts.version }
        : { contractId, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
    include: { lines: true },
    orderBy: { versionNumber: 'asc' },
  });
  if (opts.version !== undefined && schedules.length === 0) {
    throw new NotFoundException(`Version ${opts.version} du barème introuvable`);
  }
  const engineSchedules = schedules.map(toEngineSchedule);

  const overrideRows = await tx.priceOverride.findMany({
    where: { contractId, status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }],
  });

  return {
    contract,
    schedules,
    engineSchedules,
    indexes: await loadIndexes(tx, referencedIndexCodes(engineSchedules)),
    ruleCatalog: await loadRuleCatalog(tx),
    overrides: overrideRows.filter((o) => o.status === 'ACTIVE').map(toEngineOverride),
    pendingOverrides: overrideRows.filter((o) => o.status === 'PENDING_APPROVAL'),
  };
}
