import { PricingError } from './errors.js';
import { D, parseDecimal, parseIsoDate, parsePeriod, roundToScale } from './money.js';
import { priceAt, type PricingResult } from './price-at.js';
import { selectSchedule } from './schedule.js';
import type { PriceIndex, PricingInput, PricingLine, ResolvedQuantity } from './types.js';

/**
 * Simulateur : « que deviendrait le barème si… ». (brief §5 « Simulateur »)
 *
 * Construit une COPIE modifiée de l'entrée, appelle priceAt deux fois (avant /
 * après) et calcule les écarts ligne à ligne et sur les totaux. Aucun effet de
 * bord, l'entrée n'est jamais modifiée : le simulateur est un simple client
 * du moteur, il n'a pas de règle de calcul propre — ce qui garantit que le
 * prix simulé est exactement le prix qui serait facturé.
 *
 * Changements possibles :
 *  - indexValues : valeurs d'indice hypothétiques (ajout ou remplacement
 *    d'une période). `publishedAt` par défaut : le 1er jour de la période,
 *    pour qu'une valeur simulée soit « connue » à toute date de ce mois ou
 *    postérieure avec la règle LATEST_PUBLISHED ;
 *  - quantities : nouvelle quantité d'une ligne (tracée « simulation ») ;
 *  - linePrices : nouveau prix de BASE d'une ligne (la ligne passe en mode
 *    MANUAL). La révision indicielle et les dérogations de la ligne
 *    continuent de s'appliquer : on simule un changement de prix catalogue,
 *    pas un prix final forcé. Refusé sur une ligne en paliers ou une remise.
 *
 * `options.beforeDate` permet de comparer deux dates (typiquement : le prix
 * actuel et le prix après la prochaine révision). Par défaut, avant et après
 * sont calculés à la même date.
 */

export interface SimulationChanges {
  readonly indexValues?: readonly {
    readonly indexCode: string;
    readonly period: string;
    readonly value: string;
    readonly publishedAt?: string;
  }[];
  readonly quantities?: readonly { readonly lineId: string; readonly quantity: string }[];
  readonly linePrices?: readonly { readonly lineId: string; readonly unitPrice: string }[];
}

export interface SimulationOptions {
  /** Date du calcul « avant » (défaut : la même date que « après »). */
  readonly beforeDate?: string;
}

export interface LineDelta {
  readonly lineId: string;
  readonly label: string;
  /** null si la ligne n'existe que d'un côté (dates de barèmes différentes). */
  readonly beforeCents: bigint | null;
  readonly afterCents: bigint | null;
  readonly deltaCents: bigint;
  /** Écart relatif en % à 2 décimales ; null si la base est nulle ou absente. */
  readonly deltaPercent: string | null;
}

export interface TotalsDelta {
  readonly htCents: bigint;
  readonly vatCents: bigint;
  readonly ttcCents: bigint;
  readonly monthlyRecurringCents: bigint;
  readonly annualRecurringCents: bigint;
}

export interface SimulationResult {
  readonly before: PricingResult;
  readonly after: PricingResult;
  readonly lineDeltas: readonly LineDelta[];
  readonly totalsDelta: TotalsDelta;
}

function unknownLine(lineId: string): PricingError {
  return new PricingError('INVALID_LINE', `Simulation : ligne « ${lineId} » absente du barème applicable.`, { lineId });
}

function applyChanges(input: PricingInput, date: string, changes: SimulationChanges): PricingInput {
  const target = selectSchedule(input.schedules, date);
  const ids = new Set(target.lines.map((l) => l.id));

  // Indices : copie profonde des séries touchées uniquement.
  let indexes: readonly PriceIndex[] = input.indexes ?? [];
  for (const [i, c] of (changes.indexValues ?? []).entries()) {
    parsePeriod(c.period, `simulation.indexValues[${i}].period`);
    parseDecimal(c.value, `simulation.indexValues[${i}].value`, { maxScale: 10 });
    const publishedAt = parseIsoDate(c.publishedAt ?? `${c.period}-01`, `simulation.indexValues[${i}].publishedAt`);
    const existing = indexes.find((x) => x.code === c.indexCode);
    const values = (existing?.values ?? []).filter((v) => v.period !== c.period).concat([{ period: c.period, value: c.value, publishedAt }]);
    const updated: PriceIndex = { code: c.indexCode, name: existing?.name ?? c.indexCode, values };
    indexes = existing ? indexes.map((x) => (x === existing ? updated : x)) : [...indexes, updated];
  }

  const quantityChanges = new Map<string, string>();
  for (const q of changes.quantities ?? []) {
    if (!ids.has(q.lineId)) throw unknownLine(q.lineId);
    parseDecimal(q.quantity, `simulation : quantité de ${q.lineId}`);
    quantityChanges.set(q.lineId, q.quantity);
  }
  const priceChanges = new Map<string, string>();
  for (const p of changes.linePrices ?? []) {
    if (!ids.has(p.lineId)) throw unknownLine(p.lineId);
    parseDecimal(p.unitPrice, `simulation : prix de ${p.lineId}`);
    priceChanges.set(p.lineId, p.unitPrice);
  }

  const lines = target.lines.map((l): PricingLine => {
    let out = l;
    const price = priceChanges.get(l.id);
    if (price !== undefined) {
      if (l.kind === 'TIERED' || l.kind === 'DISCOUNT') {
        throw new PricingError('INVALID_LINE', `Simulation : la ligne ${l.id} (paliers ou remise) n’a pas de prix unitaire à modifier.`, {
          lineId: l.id,
        });
      }
      const { rule: _rule, formula: _formula, ...rest } = out;
      out = { ...rest, mode: 'MANUAL', unitPrice: price };
    }
    if (quantityChanges.has(l.id)) out = { ...out, quantity: { source: 'PROVIDER' } };
    return out;
  });

  const quantities: ResolvedQuantity[] = (input.quantities ?? [])
    .filter((q) => !quantityChanges.has(q.lineId))
    .concat([...quantityChanges].map(([lineId, quantity]) => ({ lineId, quantity, source: 'simulation', observedAt: null })));

  return {
    ...input,
    schedules: input.schedules.map((s) => (s === target ? { ...s, lines } : s)),
    indexes,
    quantities,
  };
}

function percent(before: bigint, delta: bigint): string | null {
  if (before === 0n) return null;
  return roundToScale(D(delta.toString()).div(D(before.toString())).times(100), 2).toFixed(2);
}

export function simulate(input: PricingInput, date: string, changes: SimulationChanges, options: SimulationOptions = {}): SimulationResult {
  const before = priceAt(input, options.beforeDate ?? date);
  const after = priceAt(applyChanges(input, date, changes), date);

  const beforeById = new Map(before.lines.map((l) => [l.lineId, l]));
  const afterIds = new Set(after.lines.map((l) => l.lineId));
  const lineDeltas: LineDelta[] = after.lines.map((a) => {
    const b = beforeById.get(a.lineId);
    const beforeCents = b?.totalHtCents ?? null;
    const deltaCents = a.totalHtCents - (beforeCents ?? 0n);
    return {
      lineId: a.lineId,
      label: a.label,
      beforeCents,
      afterCents: a.totalHtCents,
      deltaCents,
      deltaPercent: beforeCents === null ? null : percent(beforeCents, deltaCents),
    };
  });
  for (const b of before.lines) {
    if (!afterIds.has(b.lineId)) {
      lineDeltas.push({
        lineId: b.lineId,
        label: b.label,
        beforeCents: b.totalHtCents,
        afterCents: null,
        deltaCents: -b.totalHtCents,
        deltaPercent: percent(b.totalHtCents, -b.totalHtCents),
      });
    }
  }

  const t0 = before.totals;
  const t1 = after.totals;
  return {
    before,
    after,
    lineDeltas,
    totalsDelta: {
      htCents: t1.htCents - t0.htCents,
      vatCents: t1.vatCents - t0.vatCents,
      ttcCents: t1.ttcCents - t0.ttcCents,
      monthlyRecurringCents: t1.monthlyRecurringCents - t0.monthlyRecurringCents,
      annualRecurringCents: t1.annualRecurringCents - t0.annualRecurringCents,
    },
  };
}
