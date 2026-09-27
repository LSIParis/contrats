import { D, toCents } from './money.js';
import { computeTotals, priceAt, type PricedLine, type PricingResult, type PricingTotals } from './price-at.js';
import { resolveSettings } from './schedule.js';
import type { PricingLine, PricingSchedule, PricingSettings, Recurrence } from './types.js';

/**
 * Tableau de prix interactif des propositions commerciales (brief §12.4,
 * annexe C, docs/contrats/11-propositions.md §4).
 *
 * DEUX étapes, et c'est toute la règle « aucun calcul de prix hors du moteur » :
 *
 *   1. CONFIGURATION (ce module) : quelles lignes sont retenues et avec quelle
 *      quantité — choix exclusifs (formule, engagement), options cochées,
 *      quantités bornées, lignes liées (mise en service), règles de
 *      dépendance (REQUIRES, REQUIRED_IF_ANY, AUTO_INCLUDE, AT_LEAST_ONE),
 *      présélection par effectif. Aucun montant n'est calculé ici.
 *   2. CALCUL : la configuration devient un barème du moteur (`PricingLine`
 *      MANUAL, prix unitaires du modèle) évalué par `priceAt` — arrondis,
 *      remises (DISCOUNT), TVA et ventilation sont ceux du moteur. Le
 *      complément de minimum mensuel est une ligne FLAT_MONTHLY ajoutée au
 *      barème puis RE-calculée par le moteur : il fait partie du barème figé.
 *
 * Le barème produit (`engineSchedule`) est EXACTEMENT celui que l'on fige à
 * l'acceptation (PricingSnapshot) puis que l'on reprend comme barème initial
 * du contrat : prix affiché = prix figé = barème initial, par construction.
 *
 * La spécification exécutable de ces calculs est `reference-pricing.ts`
 * (annexe C, seed) : le test `proposal-templates.engine.test.ts` exige que ce
 * module donne les mêmes totaux sur tous les cas de contrôle.
 */

// ---------------------------------------------------------------------------
// Définition d'un tableau de prix (forme des fichiers de l'annexe C)
// ---------------------------------------------------------------------------

export type ProposalPriceStatus = 'VALIDATED' | 'TO_VALIDATE';
export type ProposalRecurrence = 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'INFO';
export type ProposalLineKind = 'REQUIRED' | 'OPTIONAL' | 'SETUP' | 'INFO';
export type ProposalLineGroup = 'RECURRING' | 'SETUP' | 'OPTIONS' | 'YEARLY' | 'OUT_OF_SCOPE';

export interface ProposalQuantitySpec {
  /** Entier, ou balise de fusion « {{parc.nbPostes}} » résolue par le contexte. */
  readonly default: number | string;
  readonly min: number;
  readonly max?: number | undefined;
  readonly maxFrom?: string | undefined;
  readonly linkedTo?: string | undefined;
  readonly editableByClient: boolean;
}

export type ProposalLinePricing =
  | { readonly unitPriceCents: number }
  | { readonly dependsOn: string; readonly byChoice: Readonly<Record<string, number>> };

export interface ProposalPricingLine {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly kind: ProposalLineKind;
  readonly unit: string;
  readonly recurrence: ProposalRecurrence;
  readonly quantity?: ProposalQuantitySpec | undefined;
  readonly pricing: ProposalLinePricing;
  readonly priceFrom?: boolean | undefined;
  readonly priceStatus: ProposalPriceStatus;
  readonly priceStatusByChoice?: Readonly<Record<string, ProposalPriceStatus>> | undefined;
  readonly priceSource?: string | undefined;
  readonly setupLineKey?: string | undefined;
  readonly indexation?: { readonly index: 'SYNTEC'; readonly a: number; readonly b: number } | undefined;
  readonly group: ProposalLineGroup;
}

export interface ProposalChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly default?: boolean | undefined;
  readonly commitmentMonths?: number | undefined;
}

export interface ProposalChoice {
  readonly key: string;
  readonly label: string;
  readonly options: readonly ProposalChoiceOption[];
  readonly editableByClient: boolean;
  readonly priceStatus?: ProposalPriceStatus | undefined;
  readonly note?: string | undefined;
}

export type ProposalRule =
  | { readonly type: 'MINIMUM_MONTHLY'; readonly key: string; readonly amountCents: number; readonly label: string; readonly priceStatus: ProposalPriceStatus; readonly priceSource?: string }
  | { readonly type: 'REQUIRES'; readonly key: string; readonly line: string; readonly requires: readonly string[]; readonly message: string }
  | { readonly type: 'REQUIRED_IF_ANY'; readonly key: string; readonly line: string; readonly ifAny: readonly string[]; readonly message: string }
  | { readonly type: 'AUTO_INCLUDE'; readonly key: string; readonly line: string; readonly when: string }
  | { readonly type: 'AT_LEAST_ONE'; readonly key: string; readonly lines: readonly string[]; readonly message: string }
  | {
      readonly type: 'DISCOUNT_PERCENT';
      readonly key: string;
      readonly percent: number;
      readonly appliesTo: readonly string[];
      readonly when: string;
      readonly label: string;
      readonly priceStatus: ProposalPriceStatus;
      readonly priceSource?: string;
    }
  | {
      readonly type: 'PRESELECT_CHOICE';
      readonly key: string;
      readonly choice: string;
      readonly field: string;
      readonly ranges: readonly { readonly min?: number | undefined; readonly max?: number | undefined; readonly value: string }[];
    };

export interface ProposalPricingDefinition {
  readonly choices: readonly ProposalChoice[];
  readonly lines: readonly ProposalPricingLine[];
  readonly rules: readonly ProposalRule[];
  /** TVA du modèle (20 par défaut). */
  readonly vatRatePercent: number;
}

/** Choix du client (formule, engagement, options, quantités). */
export interface ProposalSelectionInput {
  readonly choices?: Readonly<Record<string, string>> | undefined;
  readonly quantities?: Readonly<Record<string, number>> | undefined;
  readonly selectedOptions?: readonly string[] | undefined;
  /** Valeurs des balises (quantités par défaut, présélection par effectif). */
  readonly context?: Readonly<Record<string, number | string>> | undefined;
}

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export interface ProposalBucket {
  readonly htCents: bigint;
  readonly vatCents: bigint;
  readonly ttcCents: bigint;
}

export interface QuotedLine {
  readonly key: string;
  readonly label: string;
  readonly group: ProposalLineGroup | 'DISCOUNT' | 'MINIMUM';
  readonly recurrence: ProposalRecurrence | 'DISCOUNT' | 'MINIMUM';
  readonly unit: string;
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly totalHtCents: bigint;
  readonly priceStatus: ProposalPriceStatus;
  readonly priceFrom: boolean;
}

export interface PendingValidation {
  readonly scope: 'LINE' | 'RULE' | 'SECTION' | 'CHOICE';
  readonly key: string;
  readonly label: string;
  readonly choiceValue?: string;
}

export interface ProposalQuote {
  readonly choices: Readonly<Record<string, string>>;
  readonly quantities: Readonly<Record<string, number>>;
  readonly selectedOptions: readonly string[];
  readonly commitmentMonths: number;
  /** Lignes retenues (quantité > 0), remise et complément de minimum inclus. */
  readonly lines: readonly QuotedLine[];
  /** Tarifs affichés non sélectionnables (hors forfait), repris dans le contrat. */
  readonly infoLines: readonly QuotedLine[];
  readonly oneTime: ProposalBucket;
  readonly monthly: ProposalBucket;
  readonly quarterly: ProposalBucket;
  readonly yearly: ProposalBucket;
  /** mensuel × mois + trimestriel × (mois / 3) + annuel × (mois / 12), hors ponctuel. */
  readonly commitment: ProposalBucket;
  /** Erreurs de configuration (bornes, dépendances) : une configuration en erreur ne s'accepte pas. */
  readonly errors: readonly string[];
  /** Éléments « à valider » retenus : bloquent le passage à PRÊTE. */
  readonly blockingValidations: readonly PendingValidation[];
  /** Barème du moteur : figé tel quel à l'acceptation, repris par le contrat. */
  readonly engineSchedule: PricingSchedule | null;
  readonly engineResult: PricingResult | null;
}

// ---------------------------------------------------------------------------
// Étape 1 — configuration
// ---------------------------------------------------------------------------

function defaultChoice(c: ProposalChoice): string {
  return (c.options.find((o) => o.default) ?? c.options[0])?.value ?? '';
}

/** Choix retenus : défaut du modèle < présélection par le contexte < choix explicite. */
export function resolveProposalChoices(def: ProposalPricingDefinition, sel: ProposalSelectionInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of def.choices) out[c.key] = defaultChoice(c);
  for (const r of def.rules) {
    if (r.type !== 'PRESELECT_CHOICE') continue;
    const v = Number(sel.context?.[r.field]);
    if (!Number.isFinite(v)) continue;
    const hit = r.ranges.find((x) => (x.min ?? -Infinity) <= v && v <= (x.max ?? Infinity));
    if (hit) out[r.choice] = hit.value;
  }
  return { ...out, ...(sel.choices ?? {}) };
}

function unitPriceCents(l: ProposalPricingLine, choices: Readonly<Record<string, string>>): number | undefined {
  if ('unitPriceCents' in l.pricing) return l.pricing.unitPriceCents;
  const v = choices[l.pricing.dependsOn];
  return v === undefined ? undefined : l.pricing.byChoice[v];
}

export function effectiveLinePriceStatus(l: ProposalPricingLine, choices: Readonly<Record<string, string>>): ProposalPriceStatus {
  if (l.priceStatusByChoice && 'dependsOn' in l.pricing) {
    const v = choices[l.pricing.dependsOn];
    const s = v === undefined ? undefined : l.priceStatusByChoice[v];
    if (s) return s;
  }
  return l.priceStatus;
}

interface Configuration {
  readonly choices: Record<string, string>;
  readonly commitmentMonths: number;
  /** clé → quantité retenue (lignes incluses, SETUP comprises). */
  readonly included: Map<string, number>;
  readonly errors: string[];
}

function configure(def: ProposalPricingDefinition, sel: ProposalSelectionInput): Configuration {
  const errors: string[] = [];
  const choices = resolveProposalChoices(def, sel);
  for (const c of def.choices) {
    if (!c.options.some((o) => o.value === choices[c.key])) errors.push(`valeur invalide pour ${c.key} : ${choices[c.key]}`);
  }
  for (const k of Object.keys(sel.choices ?? {})) {
    if (!def.choices.some((c) => c.key === k)) errors.push(`choix inconnu : ${k}`);
  }
  const commitmentChoice = def.choices.find((c) => c.options.some((o) => o.commitmentMonths));
  const commitmentMonths = commitmentChoice?.options.find((o) => o.value === choices[commitmentChoice.key])?.commitmentMonths ?? 0;

  const byKey = new Map(def.lines.map((l) => [l.key, l]));
  const selected = new Set(sel.selectedOptions ?? []);
  for (const k of selected) if (byKey.get(k)?.kind !== 'OPTIONAL') errors.push(`${k} n'est pas une option sélectionnable`);
  for (const k of Object.keys(sel.quantities ?? {})) if (!byKey.has(k)) errors.push(`ligne inconnue : ${k}`);

  const rawQty = (l: ProposalPricingLine): number => {
    if (sel.quantities && Object.hasOwn(sel.quantities, l.key)) return sel.quantities[l.key] as number;
    const d = l.quantity?.default ?? 0;
    if (typeof d === 'number') return d;
    const tag = d.slice(2, -2);
    const v = Number(sel.context?.[tag]);
    if (!Number.isFinite(v)) {
      errors.push(`ligne ${l.key} : balise ${d} non résolue`);
      return 0;
    }
    return v;
  };

  // Lignes incluses (hors SETUP), puis règles d'inclusion.
  const included = new Map<string, number>();
  for (const l of def.lines) {
    if (l.kind === 'REQUIRED' || (l.kind === 'OPTIONAL' && selected.has(l.key))) included.set(l.key, rawQty(l));
  }
  for (const r of def.rules) {
    if (r.type !== 'REQUIRED_IF_ANY') continue;
    const target = byKey.get(r.line);
    if (target && r.ifAny.some((k) => (included.get(k) ?? 0) > 0) && !included.has(r.line)) included.set(r.line, rawQty(target));
  }
  for (const r of def.rules) {
    if (r.type !== 'AUTO_INCLUDE') continue;
    const target = byKey.get(r.line);
    if (target && included.has(r.when) && target.kind !== 'SETUP' && !included.has(r.line)) included.set(r.line, rawQty(target));
  }
  // Frais de mise en service : quantité = celle de la ligne liée.
  for (const l of def.lines) {
    const linked = l.kind === 'SETUP' ? l.quantity?.linkedTo : undefined;
    if (linked && included.has(linked)) included.set(l.key, included.get(linked) as number);
  }

  // Bornes, contrôlées côté serveur (le client peut forger n'importe quelle valeur).
  for (const [k, q] of included) {
    const l = byKey.get(k) as ProposalPricingLine;
    const qd = l.quantity;
    if (!Number.isInteger(q) || q < 0) {
      errors.push(`ligne ${k} : quantité invalide ${q}`);
      continue;
    }
    if (!qd) continue;
    if (l.kind !== 'SETUP' && q < qd.min) errors.push(`ligne ${k} : quantité ${q} < minimum ${qd.min}`);
    if (qd.max !== undefined && q > qd.max) errors.push(`ligne ${k} : quantité ${q} > maximum ${qd.max}`);
    if (qd.maxFrom && q > (included.get(qd.maxFrom) ?? 0)) errors.push(`ligne ${k} : quantité ${q} supérieure à celle de ${qd.maxFrom}`);
    // Une quantité non modifiable par le client ne peut pas s'écarter de son défaut.
    if (!qd.editableByClient && l.kind !== 'SETUP' && sel.quantities && Object.hasOwn(sel.quantities, k)) {
      const d = qd.default;
      if (typeof d === 'number' && q !== d) errors.push(`ligne ${k} : quantité non modifiable`);
    }
  }

  // Règles de dépendance.
  for (const r of def.rules) {
    if (r.type === 'REQUIRES' && included.has(r.line) && r.requires.some((k) => !included.has(k))) errors.push(r.message);
    if (r.type === 'AT_LEAST_ONE' && !r.lines.some((k) => (included.get(k) ?? 0) > 0)) errors.push(r.message);
  }
  for (const l of def.lines) {
    if ((included.get(l.key) ?? 0) > 0 && unitPriceCents(l, choices) === undefined) {
      errors.push(`ligne ${l.key} : pas de prix pour ce choix`);
    }
  }
  return { choices, commitmentMonths, included, errors };
}

// ---------------------------------------------------------------------------
// Étape 2 — calcul par le moteur
// ---------------------------------------------------------------------------

const ENGINE_RECURRENCE: Record<Exclude<ProposalRecurrence, 'INFO'>, Recurrence> = {
  ONE_TIME: 'ONE_OFF',
  MONTHLY: 'MONTHLY',
  QUARTERLY: 'QUARTERLY',
  YEARLY: 'YEARLY',
};

const centsToEuroString = (cents: number | bigint): string => {
  const c = BigInt(cents);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/** Ligne du moteur correspondant à une ligne de proposition retenue. */
function toEngineLine(l: ProposalPricingLine, qty: number, priceCents: number, vat: string): PricingLine {
  const base = {
    id: l.key,
    code: l.key,
    label: l.label,
    unit: l.unit,
    mode: 'MANUAL' as const,
    vatRatePercent: vat,
    unitPrice: centsToEuroString(priceCents),
    quantity: { source: 'FIXED' as const, value: String(qty) },
  };
  if (l.recurrence === 'INFO') {
    // Tarif affiché (régie, jours additionnels) : quantité 0, repris au barème.
    return { ...base, kind: /heure/i.test(l.unit) ? 'HOURLY' : 'UNIT', recurrence: 'ONE_OFF' };
  }
  if (l.recurrence === 'ONE_TIME') return { ...base, kind: 'SETUP_FEE' };
  return { ...base, kind: 'UNIT', recurrence: ENGINE_RECURRENCE[l.recurrence] };
}

const EMPTY_BUCKET: ProposalBucket = { htCents: 0n, vatCents: 0n, ttcCents: 0n };

function bucket(lines: readonly PricedLine[], settings: PricingSettings): ProposalBucket {
  if (lines.length === 0) return EMPTY_BUCKET;
  const t: PricingTotals = computeTotals(lines, settings);
  return { htCents: t.htCents, vatCents: t.vatCents, ttcCents: t.ttcCents };
}

export interface QuoteOptions {
  /** Date de calcul « YYYY-MM-DD » (le barème produit est valable à partir de cette date). */
  readonly date: string;
  readonly settings?: Partial<PricingSettings> | undefined;
  /** Identifiant du barème produit (traçabilité du snapshot). */
  readonly scheduleId?: string | undefined;
}

export function quoteProposal(
  def: ProposalPricingDefinition,
  sel: ProposalSelectionInput,
  opts: QuoteOptions,
): ProposalQuote {
  const settings = resolveSettings(opts.settings);
  const cfg = configure(def, sel);
  const errors = [...cfg.errors];
  const vat = String(def.vatRatePercent);
  const byKey = new Map(def.lines.map((l) => [l.key, l]));

  const quantities: Record<string, number> = {};
  for (const [k, q] of cfg.included) quantities[k] = q;
  const selectedOptions = def.lines.filter((l) => l.kind === 'OPTIONAL' && cfg.included.has(l.key)).map((l) => l.key);

  const empty = (): ProposalQuote => ({
    choices: cfg.choices,
    quantities,
    selectedOptions,
    commitmentMonths: cfg.commitmentMonths,
    lines: [],
    infoLines: [],
    oneTime: EMPTY_BUCKET,
    monthly: EMPTY_BUCKET,
    quarterly: EMPTY_BUCKET,
    yearly: EMPTY_BUCKET,
    commitment: EMPTY_BUCKET,
    errors,
    blockingValidations: [],
    engineSchedule: null,
    engineResult: null,
  });
  // Quantités ou prix inexploitables : le moteur ne calcule pas un barème faux.
  if ([...cfg.included.values()].some((q) => !Number.isInteger(q) || q < 0)) return empty();
  if (errors.some((e) => /pas de prix pour ce choix|valeur invalide/.test(e))) return empty();

  // Barème du moteur : lignes retenues (quantité > 0) dans l'ordre du modèle,
  // puis les tarifs affichés (quantité 0), puis les remises.
  const engineLines: PricingLine[] = [];
  for (const l of def.lines) {
    const q = cfg.included.get(l.key) ?? 0;
    if (l.kind === 'INFO' || q === 0) continue;
    engineLines.push(toEngineLine(l, q, unitPriceCents(l, cfg.choices) as number, vat));
  }
  for (const l of def.lines) {
    if (l.kind !== 'INFO') continue;
    const p = unitPriceCents(l, cfg.choices);
    if (p !== undefined) engineLines.push(toEngineLine(l, 0, p, vat));
  }
  for (const r of def.rules) {
    if (r.type !== 'DISCOUNT_PERCENT' || !cfg.included.has(r.when)) continue;
    const targets = r.appliesTo.filter((k) => (cfg.included.get(k) ?? 0) > 0);
    if (targets.length === 0) continue;
    engineLines.push({
      id: r.key,
      code: r.key,
      label: r.label,
      unit: 'remise',
      kind: 'DISCOUNT',
      mode: 'MANUAL',
      vatRatePercent: vat,
      discount: { type: 'PERCENT', value: String(r.percent), appliesTo: { scope: 'LINES', lineIds: targets } },
    });
  }

  const schedule = (lines: PricingLine[]): PricingSchedule => ({
    id: opts.scheduleId ?? 'proposal',
    validFrom: opts.date,
    validTo: null,
    currency: 'EUR',
    lines,
  });

  let engineSchedule = schedule(engineLines);
  let result = priceAt({ schedules: [engineSchedule], settings }, opts.date);

  // Minimum mensuel : complément = minimum − mensuel (après remise), ajouté
  // comme forfait mensuel puis RE-calculé par le moteur.
  const minimum = def.rules.find((r): r is Extract<ProposalRule, { type: 'MINIMUM_MONTHLY' }> => r.type === 'MINIMUM_MONTHLY');
  if (minimum && result.totals.monthlyLinesCents < BigInt(minimum.amountCents)) {
    const complement = BigInt(minimum.amountCents) - result.totals.monthlyLinesCents;
    engineSchedule = schedule([
      ...engineLines,
      {
        id: minimum.key,
        code: minimum.key,
        label: minimum.label,
        unit: 'forfait / mois',
        kind: 'FLAT_MONTHLY',
        mode: 'MANUAL',
        vatRatePercent: vat,
        unitPrice: centsToEuroString(complement),
        quantity: { source: 'FIXED', value: '1' },
      },
    ]);
    result = priceAt({ schedules: [engineSchedule], settings }, opts.date);
  }

  const lines: QuotedLine[] = [];
  const infoLines: QuotedLine[] = [];
  for (const p of result.lines) {
    const tl = byKey.get(p.lineId);
    const rule = def.rules.find((r) => r.key === p.lineId);
    const unitCents = toCents(D(p.unitPrice));
    const q: QuotedLine = {
      key: p.lineId,
      label: p.label,
      group: tl ? tl.group : rule?.type === 'MINIMUM_MONTHLY' ? 'MINIMUM' : 'DISCOUNT',
      recurrence: tl ? tl.recurrence : rule?.type === 'MINIMUM_MONTHLY' ? 'MINIMUM' : 'DISCOUNT',
      unit: p.unit,
      quantity: Number(p.quantity),
      unitPriceCents: p.kind === 'DISCOUNT' ? p.totalHtCents : unitCents,
      totalHtCents: p.totalHtCents,
      priceStatus: tl
        ? effectiveLinePriceStatus(tl, cfg.choices)
        : rule && 'priceStatus' in rule
          ? rule.priceStatus
          : 'VALIDATED',
      priceFrom: tl?.priceFrom ?? false,
    };
    (tl?.kind === 'INFO' ? infoLines : lines).push(q);
  }

  const byRec = (...recs: Recurrence[]) =>
    result.lines.filter((l) => recs.includes(l.recurrence) && byKey.get(l.lineId)?.kind !== 'INFO');
  const oneTime = bucket(byRec('ONE_OFF'), result.settings);
  const monthly = bucket(byRec('MONTHLY'), result.settings);
  const quarterly = bucket(byRec('QUARTERLY'), result.settings);
  const yearly = bucket(byRec('YEARLY'), result.settings);

  const m = BigInt(cfg.commitmentMonths);
  if (quarterly.htCents !== 0n && cfg.commitmentMonths % 3) errors.push('durée non multiple de 3 mois avec une ligne trimestrielle');
  if (yearly.htCents !== 0n && cfg.commitmentMonths % 12) errors.push('durée non multiple de 12 mois avec une ligne annuelle');
  // Total sur la durée : chaque période est facturée avec SA TVA (arrondie par
  // facture) ; le total TVA est donc la somme des TVA de période.
  const over = (f: (b: ProposalBucket) => bigint) => f(monthly) * m + f(quarterly) * (m / 3n) + f(yearly) * (m / 12n);
  const commitment: ProposalBucket = {
    htCents: over((b) => b.htCents),
    vatCents: over((b) => b.vatCents),
    ttcCents: over((b) => b.ttcCents),
  };

  return {
    choices: cfg.choices,
    quantities,
    selectedOptions,
    commitmentMonths: cfg.commitmentMonths,
    lines,
    infoLines,
    oneTime,
    monthly,
    quarterly,
    yearly,
    commitment,
    errors,
    blockingValidations: blockingValidationsOf(def, lines, cfg.choices),
    engineSchedule,
    engineResult: result,
  };
}

// ---------------------------------------------------------------------------
// Éléments « à valider » (annexe C : même logique que reference-pricing.ts)
// ---------------------------------------------------------------------------

function blockingValidationsOf(
  def: ProposalPricingDefinition,
  quoted: readonly QuotedLine[],
  _choices: Readonly<Record<string, string>>,
): PendingValidation[] {
  const out: PendingValidation[] = [];
  const lineKeys = new Set(def.lines.map((l) => l.key));
  for (const x of quoted) {
    if (x.priceStatus === 'TO_VALIDATE') out.push({ scope: lineKeys.has(x.key) ? 'LINE' : 'RULE', key: x.key, label: x.label });
  }
  for (const c of def.choices) if (c.priceStatus === 'TO_VALIDATE') out.push({ scope: 'CHOICE', key: c.key, label: c.label });
  return out;
}

/** Sections dont le contenu est « à valider » (engagements chiffrés) et qui sont conservées. */
export function blockingSectionValidations(
  sections: readonly { readonly key: string; readonly title: string; readonly validationStatus?: ProposalPriceStatus | undefined; readonly excluded?: boolean | undefined }[],
): PendingValidation[] {
  return sections
    .filter((s) => s.validationStatus === 'TO_VALIDATE' && !s.excluded)
    .map((s) => ({ scope: 'SECTION' as const, key: s.key, label: s.title }));
}

/**
 * Éléments « à valider » d'un modèle, tous choix confondus : alimente l'écran
 * d'administration « Prix à valider » (même logique que `listPendingValidations`).
 */
export function listPendingValidations(
  def: ProposalPricingDefinition,
  sections: readonly { readonly key: string; readonly title: string; readonly validationStatus?: ProposalPriceStatus | undefined }[] = [],
): PendingValidation[] {
  const out: PendingValidation[] = [];
  for (const l of def.lines) {
    if (l.priceStatusByChoice) {
      for (const [v, s] of Object.entries(l.priceStatusByChoice)) {
        if (s === 'TO_VALIDATE') out.push({ scope: 'LINE', key: l.key, label: l.label, choiceValue: v });
      }
    } else if (l.priceStatus === 'TO_VALIDATE') out.push({ scope: 'LINE', key: l.key, label: l.label });
  }
  for (const r of def.rules) {
    if ('priceStatus' in r && r.priceStatus === 'TO_VALIDATE') out.push({ scope: 'RULE', key: r.key, label: r.label });
  }
  for (const s of sections) if (s.validationStatus === 'TO_VALIDATE') out.push({ scope: 'SECTION', key: s.key, label: s.title });
  for (const c of def.choices) if (c.priceStatus === 'TO_VALIDATE') out.push({ scope: 'CHOICE', key: c.key, label: c.label });
  return out;
}
