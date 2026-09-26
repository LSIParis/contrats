import { FormulaError, PricingError } from './errors.js';
import { evaluateFormula } from './formula/evaluator.js';
import { parseFormula } from './formula/parser.js';
import { lookupIndexValue } from './indexes.js';
import { centsToEuros, D, formatCents, parseDecimal, parseIsoDate, roundToScale, toCents, type Decimal } from './money.js';
import { selectOverride } from './overrides.js';
import { computeRevision } from './revision.js';
import { adjustmentFor, findRule, gridUnitPrice } from './rules.js';
import { resolveSettings, selectSchedule } from './schedule.js';
import { computeTiered } from './tiers.js';
import type { TraceStep } from './trace.js';
import type {
  LineKind,
  PriceIndex,
  PriceOverride,
  PricingContext,
  PricingInput,
  PricingLine,
  PricingMode,
  PricingSettings,
  Recurrence,
  ResolvedQuantity,
  RuleCatalog,
} from './types.js';

/**
 * priceAt(input, date) — LE point d'entrée du moteur. (brief §5)
 *
 * Pure et déterministe : aucune horloge, aucun aléa, aucune E/S, aucune
 * mutation de l'entrée. Même entrée → même sortie, trace comprise (testé par
 * propriété). C'est la condition pour pouvoir rejouer un prix passé et le
 * justifier.
 *
 * La signature du brief, `priceAt(contractId, date)`, est celle de la couche
 * persistance : elle charge l'instantané du contrat, résout les quantités
 * (asynchrone, voir quantity.ts), puis appelle cette fonction. Le moteur, lui,
 * ne connaît pas les identifiants de contrat.
 *
 * Déroulé pour une ligne ordinaire (l'ordre est celui de la trace) :
 *   1. quantité (saisie ou fournie) ;
 *   2. prix de base selon le mode : MANUAL (saisi), RULE (grille ou paliers
 *      du catalogue), FORMULA (expression) — pour TIERED, un MONTANT plutôt
 *      qu'un prix unitaire ;
 *   3. révision indicielle, si la ligne en porte une et que la date de
 *      révision est atteinte ;
 *   4. ajustements du catalogue (mode RULE) ;
 *   5. arrondi du prix unitaire à `unitPriceScale` décimales (pour TIERED :
 *      prix moyen informatif, le montant exact est conservé) ;
 *   6. dérogation applicable (PriceOverride), ou raisons de sa mise à l'écart ;
 *   7. total HT exact = prix unitaire × quantité, arrondi AU CENTIME.
 * Puis les remises (DISCOUNT), calculées sur les totaux ARRONDIS de leurs
 * cibles — ce que le client voit sur sa facture —, puis les totaux.
 *
 * Totaux :
 *   - HT = somme des totaux de ligne (déjà au centime : pas de nouvel arrondi) ;
 *   - TVA : par taux, sur la SOMME HT du taux, arrondie au centime une seule
 *     fois (et non ligne à ligne : sinon N lignes à 0,006 € de TVA feraient
 *     N centimes au lieu d'un) ;
 *   - TTC = HT + TVA ;
 *   - ventilation : lignes mensuelles, annuelles, ponctuelles ; récurrent
 *     mensuel = mensuel + annuel / 12 (arrondi une fois, au centime) ;
 *     récurrent annuel = mensuel × 12 + annuel (exact). Le « chiffre
 *     d'affaires récurrent contractualisé » est `monthlyRecurringCents`.
 *
 * Montants de sortie en `bigint` (centimes) : voir money.ts, et
 * serialize.ts pour le passage en JSON.
 */

export interface PricedLine {
  readonly lineId: string;
  readonly code: string;
  readonly label: string;
  readonly unit: string;
  readonly kind: LineKind;
  readonly mode: PricingMode;
  readonly recurrence: Recurrence;
  /** Quantité retenue (chaîne décimale). « 1 » pour une remise. */
  readonly quantity: string;
  /**
   * Prix unitaire HT final (chaîne décimale, au moins `unitPriceScale`
   * décimales). Paliers : prix moyen informatif. Remise : montant de la remise.
   */
  readonly unitPrice: string;
  readonly vatRatePercent: string;
  readonly totalHtCents: bigint;
  readonly trace: readonly TraceStep[];
}

export interface VatBreakdown {
  readonly ratePercent: string;
  readonly baseHtCents: bigint;
  readonly vatCents: bigint;
}

export interface PricingTotals {
  readonly htCents: bigint;
  readonly vatCents: bigint;
  readonly ttcCents: bigint;
  /** Trié par taux croissant. */
  readonly vatByRate: readonly VatBreakdown[];
  /** HT des lignes à récurrence mensuelle. */
  readonly monthlyLinesCents: bigint;
  /** HT des lignes à récurrence annuelle. */
  readonly yearlyLinesCents: bigint;
  /** HT des lignes ponctuelles (mise en service, régie, packs…). */
  readonly oneOffCents: bigint;
  /** Récurrent mensuel HT normalisé : mensuel + annuel / 12 (arrondi au centime). */
  readonly monthlyRecurringCents: bigint;
  /** Récurrent annuel HT : mensuel × 12 + annuel. */
  readonly annualRecurringCents: bigint;
}

export interface PricingResult {
  readonly date: string;
  readonly scheduleId: string;
  readonly scheduleValidFrom: string;
  readonly scheduleValidTo: string | null;
  readonly currency: 'EUR';
  readonly settings: PricingSettings;
  readonly lines: readonly PricedLine[];
  readonly totals: PricingTotals;
}

const LINE_KINDS: ReadonlySet<string> = new Set<LineKind>([
  'FLAT_MONTHLY',
  'FLAT_YEARLY',
  'UNIT',
  'HOURLY',
  'HOUR_PACK',
  'SETUP_FEE',
  'TIERED',
  'DISCOUNT',
]);
const MODES: ReadonlySet<string> = new Set<PricingMode>(['RULE', 'FORMULA', 'MANUAL']);
const RECURRENCES: ReadonlySet<string> = new Set<Recurrence>(['MONTHLY', 'YEARLY', 'ONE_OFF']);

/** Récurrence imposée par le type : la contredire est une erreur. */
const FORCED_RECURRENCE: Partial<Record<LineKind, Recurrence>> = {
  FLAT_MONTHLY: 'MONTHLY',
  FLAT_YEARLY: 'YEARLY',
  SETUP_FEE: 'ONE_OFF',
};
/** Récurrence par défaut, surchargeable. */
const DEFAULT_RECURRENCE: Record<Exclude<LineKind, 'DISCOUNT'>, Recurrence> = {
  FLAT_MONTHLY: 'MONTHLY',
  FLAT_YEARLY: 'YEARLY',
  SETUP_FEE: 'ONE_OFF',
  UNIT: 'MONTHLY',
  TIERED: 'MONTHLY',
  HOURLY: 'ONE_OFF',
  HOUR_PACK: 'ONE_OFF',
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Ctx {
  readonly date: string;
  readonly settings: PricingSettings;
  readonly threshold: Decimal;
  readonly indexes: readonly PriceIndex[];
  readonly catalog: RuleCatalog | undefined;
  readonly context: PricingContext | undefined;
  readonly overridesByLine: ReadonlyMap<string, readonly PriceOverride[]>;
  readonly quantities: ReadonlyMap<string, ResolvedQuantity>;
}

const invalid = (line: PricingLine, msg: string) =>
  new PricingError('INVALID_LINE', `Ligne ${line.id} : ${msg}`, { lineId: line.id });

/** Affiche un décimal avec au moins `scale` décimales, sans jamais en perdre. */
const fmt = (x: Decimal, scale: number) => x.toFixed(Math.max(scale, x.decimalPlaces()));

/**
 * Rattache une erreur à sa ligne (details.lineId + préfixe du message), en
 * conservant la classe et le code : l'appelant sait QUOI a échoué et OÙ.
 */
function withLine(e: unknown, lineId: string): unknown {
  if (!(e instanceof PricingError) || e.details.lineId !== undefined) return e;
  const details = { ...e.details, lineId };
  if (e instanceof FormulaError) {
    return new FormulaError(e.code as ConstructorParameters<typeof FormulaError>[0], `Ligne ${lineId} : ${e.message}`, e.position, details);
  }
  return new PricingError(e.code, `Ligne ${lineId} : ${e.message}`, details);
}

function parseVat(line: PricingLine): Decimal {
  const v = parseDecimal(line.vatRatePercent, `ligne ${line.id} : vatRatePercent`, { maxScale: 4 });
  if (v.gt(100)) throw invalid(line, `taux de TVA ${v.toString()} % hors de [0, 100].`);
  return v;
}

function resolveRecurrence(line: PricingLine): Recurrence {
  if (line.recurrence !== undefined && !RECURRENCES.has(line.recurrence)) {
    throw invalid(line, `récurrence « ${String(line.recurrence)} » inconnue.`);
  }
  const kind = line.kind as Exclude<LineKind, 'DISCOUNT'>;
  const forced = FORCED_RECURRENCE[kind];
  if (forced && line.recurrence !== undefined && line.recurrence !== forced) {
    throw invalid(line, `une ligne ${kind} est nécessairement ${forced} (reçu ${line.recurrence}).`);
  }
  return line.recurrence ?? DEFAULT_RECURRENCE[kind];
}

function resolveQuantity(line: PricingLine, ctx: Ctx, trace: TraceStep[]): Decimal {
  const spec = line.quantity ?? { source: 'FIXED' as const, value: '1' };
  if (spec.source === 'FIXED') {
    const q = parseDecimal(spec.value, `ligne ${line.id} : quantité`);
    trace.push({ type: 'QUANTITY', source: 'FIXED', quantity: q.toString(), observedAt: null });
    return q;
  }
  if (spec.source === 'PROVIDER') {
    const r = ctx.quantities.get(line.id);
    if (!r) {
      throw new PricingError(
        'MISSING_QUANTITY',
        `Ligne ${line.id} : quantité fournie attendue (article ${spec.articleCode ?? line.code}) mais non résolue. Appeler resolveQuantities() avant priceAt().`,
        { lineId: line.id },
      );
    }
    const q = parseDecimal(r.quantity, `ligne ${line.id} : quantité fournie`);
    trace.push({ type: 'QUANTITY', source: r.source, quantity: q.toString(), observedAt: r.observedAt });
    return q;
  }
  throw invalid(line, `source de quantité inconnue.`);
}

function evaluateLineFormula(line: PricingLine, qty: Decimal, ctx: Ctx, trace: TraceStep[]): Decimal {
  const f = line.formula;
  if (!f) throw invalid(line, 'formule requise en mode FORMULA.');
  const names = new Map<string, Decimal>();
  const define = (name: string, value: Decimal) => {
    if (!IDENT_RE.test(name)) throw invalid(line, `nom de variable « ${name} » invalide.`);
    if (names.has(name)) throw invalid(line, `variable « ${name} » définie deux fois (qty et P0 sont réservées).`);
    names.set(name, value);
  };
  define('qty', qty);
  if (f.basePrice !== undefined) define('P0', parseDecimal(f.basePrice, `ligne ${line.id} : formula.basePrice`));
  for (const [k, v] of Object.entries(f.variables ?? {})) {
    define(k, parseDecimal(v, `ligne ${line.id} : variable ${k}`, { allowNegative: true, maxScale: 10 }));
  }
  for (const [k, b] of Object.entries(f.indexVariables ?? {})) {
    const at = b.date === 'PRICING_DATE' ? ctx.date : parseIsoDate(b.date, `ligne ${line.id} : ${k}.date`);
    const observation = lookupIndexValue(ctx.indexes, b.indexCode, at, b.lookup ?? ctx.settings.indexLookup);
    trace.push({ type: 'INDEX', variable: k, observation });
    define(k, D(observation.value));
  }
  const result = evaluateFormula(parseFormula(f.expression), Object.fromEntries(names), { rounding: ctx.settings.rounding });
  trace.push({
    type: 'FORMULA',
    expression: f.expression,
    variables: Object.fromEntries([...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v.toString()])),
    result: result.toString(),
  });
  return result;
}

function priceRegularLine(line: PricingLine, ctx: Ctx): PricedLine {
  const trace: TraceStep[] = [];
  const { rounding, unitPriceScale } = ctx.settings;
  const vat = parseVat(line);
  const recurrence = resolveRecurrence(line);
  const isTiered = line.kind === 'TIERED';

  if (line.kind === 'HOUR_PACK') {
    if (!line.hourPack) throw invalid(line, 'hourPack.hoursPerPack requis pour un pack d’heures.');
    if (!parseDecimal(line.hourPack.hoursPerPack, `ligne ${line.id} : hoursPerPack`).gt(0)) {
      throw invalid(line, 'hoursPerPack doit être strictement positif.');
    }
  }
  if (line.revision && line.mode === 'FORMULA') {
    throw invalid(line, 'une révision native ne se combine pas avec le mode FORMULA : écrire la révision dans la formule.');
  }

  const qty = resolveQuantity(line, ctx, trace);

  // 2. Prix de base : un prix unitaire (unit) OU un montant de paliers (amount).
  let unit: Decimal | null = null;
  let amount: Decimal | null = null;
  switch (line.mode) {
    case 'MANUAL':
      if (isTiered) {
        if (!line.tiers) throw invalid(line, 'table de paliers requise (tiers) pour une ligne TIERED en mode MANUAL.');
        const t = computeTiered(line.tiers, qty, `ligne ${line.id}`);
        trace.push({ type: 'TIERS', ruleId: null, tierMode: t.mode, bands: t.bands, amount: t.exact.toString() });
        amount = t.exact;
      } else {
        if (line.unitPrice === undefined) throw invalid(line, 'prix unitaire requis en mode MANUAL.');
        unit = parseDecimal(line.unitPrice, `ligne ${line.id} : unitPrice`);
        trace.push({ type: 'BASE_PRICE', mode: 'MANUAL', unitPrice: unit.toString() });
      }
      break;
    case 'RULE': {
      if (!line.rule) throw invalid(line, 'référence de règle requise en mode RULE.');
      const rule = findRule(ctx.catalog, line.rule.priceRuleId, line.id);
      if (rule.type === 'GRID') {
        if (isTiered) throw invalid(line, `une ligne TIERED exige une règle TIERS, pas GRID (« ${rule.id} »).`);
        unit = gridUnitPrice(rule, line.code, line.id);
        trace.push({ type: 'RULE_PRICE', ruleId: rule.id, articleCode: line.code, unitPrice: unit.toString() });
      } else if (rule.type === 'TIERS') {
        if (!isTiered) throw invalid(line, `la règle de paliers « ${rule.id} » exige une ligne TIERED.`);
        const t = computeTiered(rule.table, qty, `ligne ${line.id}`);
        trace.push({ type: 'TIERS', ruleId: rule.id, tierMode: t.mode, bands: t.bands, amount: t.exact.toString() });
        amount = t.exact;
      } else {
        throw invalid(line, `la règle de prix « ${rule.id} » doit être de type GRID ou TIERS (reçu ${rule.type}).`);
      }
      break;
    }
    case 'FORMULA':
      if (isTiered) throw invalid(line, 'une ligne TIERED ne peut pas être en mode FORMULA (paliers en MANUAL ou RULE).');
      unit = evaluateLineFormula(line, qty, ctx, trace);
      if (unit.isNegative()) {
        throw new PricingError('NEGATIVE_PRICE', `Ligne ${line.id} : la formule donne un prix négatif (${unit.toString()}). Utiliser une ligne DISCOUNT.`, {
          lineId: line.id,
        });
      }
      break;
    default:
      throw invalid(line, `mode « ${String(line.mode)} » inconnu.`);
  }

  // 3. Révision indicielle native.
  if (line.revision) {
    const rev = line.revision;
    const refDate = parseIsoDate(rev.referenceDate, `ligne ${line.id} : revision.referenceDate`);
    const revDate = parseIsoDate(rev.revisionDate, `ligne ${line.id} : revision.revisionDate`);
    if (revDate < refDate) throw invalid(line, `date de révision ${revDate} antérieure à la date de référence ${refDate}.`);
    if (ctx.date < revDate) {
      trace.push({ type: 'REVISION_NOT_EFFECTIVE', revisionDate: revDate, date: ctx.date });
    } else {
      const P0 = (unit ?? amount) as Decimal;
      const r = computeRevision(P0, rev, ctx.indexes, ctx.settings.indexLookup);
      trace.push({
        type: 'REVISION',
        formula: 'P1 = P0 × (a + b × S1 / S0)',
        appliesTo: unit !== null ? 'UNIT_PRICE' : 'AMOUNT',
        P0: P0.toString(),
        a: r.a.toString(),
        b: r.b.toString(),
        S0: r.S0,
        S1: r.S1,
        ratio: r.ratio.toString(),
        coefficient: r.coefficient.toString(),
        result: r.exact.toString(),
      });
      if (unit !== null) unit = r.exact;
      else amount = r.exact;
    }
  }

  // 4. Ajustements du catalogue (remises volume / engagement), en cascade.
  if (line.mode === 'RULE') {
    for (const ruleId of line.rule?.adjustmentRuleIds ?? []) {
      const adj = adjustmentFor(findRule(ctx.catalog, ruleId, line.id), qty, ctx.context, line.id);
      const before = (unit ?? amount) as Decimal;
      const after = before.times(D(100).minus(adj.percent)).div(100);
      trace.push({
        type: 'ADJUSTMENT',
        ruleId: adj.ruleId,
        ruleType: adj.ruleType,
        basis: adj.basis,
        threshold: adj.threshold,
        percent: adj.percent.toString(),
        before: before.toString(),
        after: after.toString(),
      });
      if (unit !== null) unit = after;
      else amount = after;
    }
  }

  // 5. Arrondi du prix unitaire (ou prix moyen des paliers, informatif).
  let unitPrice: Decimal;
  if (unit !== null) {
    unitPrice = roundToScale(unit, unitPriceScale, rounding);
    trace.push({ type: 'ROUNDING', target: 'UNIT_PRICE', exact: unit.toString(), rounded: fmt(unitPrice, unitPriceScale), scale: unitPriceScale, mode: rounding });
  } else {
    const avg = qty.isZero() ? D(0) : (amount as Decimal).div(qty);
    unitPrice = roundToScale(avg, unitPriceScale, rounding);
    trace.push({
      type: 'ROUNDING',
      target: 'AVERAGE_UNIT_PRICE',
      exact: avg.toString(),
      rounded: fmt(unitPrice, unitPriceScale),
      scale: unitPriceScale,
      mode: rounding,
    });
  }

  // 6. Dérogation.
  const selection = selectOverride(ctx.overridesByLine.get(line.id) ?? [], ctx.date, unitPrice, ctx.threshold);
  for (const s of selection.skipped) {
    trace.push({ type: 'OVERRIDE_SKIPPED', overrideId: s.overrideId, reason: s.reason, gapPercent: s.gapPercent });
  }
  if (selection.applied) {
    const a = selection.applied;
    trace.push({
      type: 'OVERRIDE_APPLIED',
      overrideId: a.override.id,
      computedUnitPrice: fmt(unitPrice, unitPriceScale),
      unitPrice: a.override.unitPrice,
      validFrom: a.override.validFrom,
      validTo: a.override.validTo,
      reason: a.override.reason,
      authorId: a.override.authorId,
      approvedBy: a.override.approvedBy ?? null,
      gapPercent: a.gapPercent === null ? null : a.gapPercent.toString(),
      requiresSecondApproval: a.requiresSecondApproval,
    });
    unitPrice = a.unitPrice;
    amount = null; // une dérogation sur une ligne en paliers la rend « plate »
  }

  if (line.kind === 'HOUR_PACK' && line.hourPack) {
    const rate = roundToScale(unitPrice.div(D(line.hourPack.hoursPerPack)), unitPriceScale, rounding);
    trace.push({ type: 'HOUR_PACK', hoursPerPack: D(line.hourPack.hoursPerPack).toString(), effectiveHourlyRate: fmt(rate, unitPriceScale) });
  }

  // 7. Total de ligne, arrondi au centime.
  const exactTotal = amount ?? unitPrice.times(qty);
  const totalHtCents = toCents(exactTotal, rounding);
  trace.push({ type: 'LINE_TOTAL', unitPrice: fmt(unitPrice, unitPriceScale), quantity: qty.toString(), exact: exactTotal.toString() });
  trace.push({ type: 'ROUNDING', target: 'LINE_TOTAL', exact: exactTotal.toString(), rounded: formatCents(totalHtCents), scale: 2, mode: rounding });

  return {
    lineId: line.id,
    code: line.code,
    label: line.label,
    unit: line.unit,
    kind: line.kind,
    mode: line.mode,
    recurrence,
    quantity: qty.toString(),
    unitPrice: fmt(unitPrice, unitPriceScale),
    vatRatePercent: vat.toString(),
    totalHtCents,
    trace,
  };
}

function priceDiscountLine(
  line: PricingLine,
  schedLines: ReadonlyMap<string, PricingLine>,
  priced: ReadonlyMap<string, PricedLine>,
  ctx: Ctx,
): PricedLine {
  const { rounding } = ctx.settings;
  if (line.mode !== 'MANUAL') throw invalid(line, 'une remise se saisit en mode MANUAL.');
  const d = line.discount;
  if (!d) throw invalid(line, 'paramètres de remise (discount) requis.');
  const vat = parseVat(line);

  let targets: PricedLine[];
  if (d.appliesTo.scope === 'SUBTOTAL') {
    targets = [...priced.values()];
  } else if (d.appliesTo.scope === 'LINES') {
    const ids = d.appliesTo.lineIds;
    if (new Set(ids).size !== ids.length) throw invalid(line, 'cible de remise en double.');
    targets = ids.map((id) => {
      const target = schedLines.get(id);
      if (!target) throw invalid(line, `cible de remise « ${id} » absente du barème.`);
      if (target.kind === 'DISCOUNT') throw invalid(line, `une remise ne peut pas porter sur une autre remise (« ${id} »).`);
      return priced.get(id) as PricedLine;
    });
  } else {
    throw invalid(line, 'portée de remise inconnue (LINES ou SUBTOTAL).');
  }
  if (targets.length === 0) throw invalid(line, 'la remise ne porte sur aucune ligne.');

  // Une remise hérite de la TVA et de la récurrence de ses cibles : elles
  // doivent donc être homogènes. Sinon, une remise par taux / par récurrence.
  const first = targets[0] as PricedLine;
  const mismatch = (msg: string) =>
    new PricingError('DISCOUNT_TARGET_MISMATCH', `Ligne ${line.id} : ${msg} Créer une remise par taux de TVA et par récurrence.`, {
      lineId: line.id,
    });
  for (const t of targets) {
    if (!D(t.vatRatePercent).eq(first.vatRatePercent)) throw mismatch('les lignes ciblées ont des taux de TVA différents.');
    if (t.recurrence !== first.recurrence) throw mismatch('les lignes ciblées ont des récurrences différentes.');
  }
  if (!vat.eq(first.vatRatePercent)) throw mismatch(`le taux de TVA de la remise (${vat.toString()} %) diffère de celui des cibles (${first.vatRatePercent} %).`);
  if (line.recurrence !== undefined && line.recurrence !== first.recurrence) {
    throw mismatch(`la récurrence de la remise (${line.recurrence}) diffère de celle des cibles (${first.recurrence}).`);
  }

  const baseCents = targets.reduce((s, t) => s + t.totalHtCents, 0n);
  const base = centsToEuros(baseCents);
  let exact: Decimal;
  const value = parseDecimal(d.value, `ligne ${line.id} : discount.value`, { maxScale: d.type === 'PERCENT' ? 4 : 6 });
  const exceeds = () =>
    new PricingError('DISCOUNT_EXCEEDS_BASE', `Ligne ${line.id} : la remise (${d.value}${d.type === 'PERCENT' ? ' %' : ' €'}) excède sa base.`, {
      lineId: line.id,
    });
  if (d.type === 'PERCENT') {
    if (value.gt(100)) throw exceeds();
    exact = base.times(value).div(100).neg();
  } else if (d.type === 'AMOUNT') {
    if (value.gt(base)) throw exceeds();
    exact = value.neg();
  } else {
    throw invalid(line, 'type de remise inconnu (PERCENT ou AMOUNT).');
  }
  const totalHtCents = toCents(exact, rounding);

  return {
    lineId: line.id,
    code: line.code,
    label: line.label,
    unit: line.unit,
    kind: 'DISCOUNT',
    mode: line.mode,
    recurrence: first.recurrence,
    quantity: '1',
    unitPrice: formatCents(totalHtCents),
    vatRatePercent: vat.toString(),
    totalHtCents,
    trace: [
      {
        type: 'DISCOUNT',
        discountType: d.type,
        value: value.toString(),
        targetLineIds: targets.map((t) => t.lineId),
        baseHtCents: baseCents.toString(),
        exact: exact.toString(),
      },
      { type: 'ROUNDING', target: 'LINE_TOTAL', exact: exact.toString(), rounded: formatCents(totalHtCents), scale: 2, mode: rounding },
    ],
  };
}

export function computeTotals(lines: readonly PricedLine[], settings: PricingSettings): PricingTotals {
  let htCents = 0n;
  let monthlyLinesCents = 0n;
  let yearlyLinesCents = 0n;
  let oneOffCents = 0n;
  const byRate = new Map<string, { rate: Decimal; base: bigint }>();
  for (const l of lines) {
    htCents += l.totalHtCents;
    if (l.recurrence === 'MONTHLY') monthlyLinesCents += l.totalHtCents;
    else if (l.recurrence === 'YEARLY') yearlyLinesCents += l.totalHtCents;
    else oneOffCents += l.totalHtCents;
    const rate = D(l.vatRatePercent);
    const key = rate.toString();
    const g = byRate.get(key) ?? { rate, base: 0n };
    byRate.set(key, { rate, base: g.base + l.totalHtCents });
  }
  const vatByRate = [...byRate.values()]
    .sort((a, b) => a.rate.comparedTo(b.rate))
    .map(({ rate, base }) => ({
      ratePercent: rate.toString(),
      baseHtCents: base,
      vatCents: toCents(centsToEuros(base).times(rate).div(100), settings.rounding),
    }));
  const vatCents = vatByRate.reduce((s, v) => s + v.vatCents, 0n);
  return {
    htCents,
    vatCents,
    ttcCents: htCents + vatCents,
    vatByRate,
    monthlyLinesCents,
    yearlyLinesCents,
    oneOffCents,
    monthlyRecurringCents: monthlyLinesCents + toCents(centsToEuros(yearlyLinesCents).div(12), settings.rounding),
    annualRecurringCents: monthlyLinesCents * 12n + yearlyLinesCents,
  };
}

export function priceAt(input: PricingInput, date: string): PricingResult {
  parseIsoDate(date, 'date');
  const settings = resolveSettings(input.settings);
  const schedule = selectSchedule(input.schedules, date);
  if (schedule.currency !== 'EUR') {
    throw new PricingError('INVALID_SETTINGS', `Barème ${schedule.id} : devise « ${String(schedule.currency)} » non prise en charge (EUR uniquement).`);
  }

  const schedLines = new Map<string, PricingLine>();
  for (const l of schedule.lines) {
    if (schedLines.has(l.id)) throw invalid(l, 'identifiant de ligne en double dans le barème.');
    if (!LINE_KINDS.has(l.kind)) throw invalid(l, `type de ligne « ${String(l.kind)} » inconnu.`);
    if (!MODES.has(l.mode)) throw invalid(l, `mode « ${String(l.mode)} » inconnu.`);
    schedLines.set(l.id, l);
  }

  const overridesByLine = new Map<string, PriceOverride[]>();
  for (const o of input.overrides ?? []) {
    const list = overridesByLine.get(o.lineId) ?? [];
    list.push(o);
    overridesByLine.set(o.lineId, list);
  }
  const ctx: Ctx = {
    date,
    settings,
    threshold: D(settings.overrideApprovalThresholdPercent),
    indexes: input.indexes ?? [],
    catalog: input.ruleCatalog,
    context: input.context,
    overridesByLine,
    quantities: new Map((input.quantities ?? []).map((q) => [q.lineId, q])),
  };

  // Lignes ordinaires d'abord, remises ensuite (elles portent sur les totaux
  // arrondis des premières) ; la sortie respecte l'ordre du barème.
  const priced = new Map<string, PricedLine>();
  for (const l of schedule.lines) {
    if (l.kind === 'DISCOUNT') continue;
    try {
      priced.set(l.id, priceRegularLine(l, ctx));
    } catch (e) {
      throw withLine(e, l.id);
    }
  }
  const regular = new Map(priced);
  const discounts = new Map<string, PricedLine>();
  for (const l of schedule.lines) {
    if (l.kind !== 'DISCOUNT') continue;
    try {
      discounts.set(l.id, priceDiscountLine(l, schedLines, regular, ctx));
    } catch (e) {
      throw withLine(e, l.id);
    }
  }
  const lines = schedule.lines.map((l) => (priced.get(l.id) ?? discounts.get(l.id)) as PricedLine);

  return {
    date,
    scheduleId: schedule.id,
    scheduleValidFrom: schedule.validFrom,
    scheduleValidTo: schedule.validTo,
    currency: 'EUR',
    settings,
    lines,
    totals: computeTotals(lines, settings),
  };
}
