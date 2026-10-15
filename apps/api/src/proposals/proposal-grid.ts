import { commitmentSuffix, gridPriceToCents, PRICE_UNITS } from '@lsi/domain';
import type { ProposalChoice, ProposalChoiceOption, ProposalPricingDefinition, ProposalPricingLine } from '@lsi/pricing';

/**
 * Lignes de proposition issues de la grille tarifaire d'un type de contrat
 * (docs/contrats/13-types-contrats.md §7). Fonctions PURES : le service lit
 * la grille, ces fonctions décident.
 *
 *  - Ajout : code, libellé, prix (en centimes) et TVA sont COPIÉS ; une
 *    version par valeur du choix d'engagement (E00, E12…). Une durée sans
 *    version proposée bloque l'ajout (on ne fabrique pas de prix).
 *  - Changement des durées proposées : les lignes de grille peuvent BASCULER
 *    vers les versions des nouvelles durées (confirmation côté interface) ;
 *    sans bascule, les prix des durées conservées restent ceux copiés et
 *    seules les nouvelles durées sont lues dans la grille.
 */

export interface GridItemForDocument {
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly unit: string;
  readonly recurrence: 'MONTHLY' | 'YEARLY' | 'ONE_OFF' | 'QUARTERLY';
  readonly vatRatePercent: string;
  readonly byMonths: ReadonlyMap<number, { code: string; unitPrice: string; effectiveFrom: string }>;
}

export class GridLineError extends Error {
  constructor(readonly code: 'NO_COMMITMENT_CHOICE' | 'VAT_MISMATCH' | 'MISSING_DURATIONS' | 'PRICE_PRECISION', message: string, readonly details: string[] = []) {
    super(message);
  }
}

export function commitmentChoiceOf(def: ProposalPricingDefinition): ProposalChoice {
  const c = def.choices.find((x) => x.options.some((o) => o.commitmentMonths !== undefined));
  if (!c) throw new GridLineError('NO_COMMITMENT_CHOICE', "La proposition n'a pas de choix de durée d'engagement.");
  return c;
}

const RECURRENCE = { MONTHLY: 'MONTHLY', YEARLY: 'YEARLY', QUARTERLY: 'QUARTERLY', ONE_OFF: 'ONE_TIME' } as const;
const unitLabel = (code: string) => PRICE_UNITS.find((u) => u.code === code)?.label ?? code;

function cents(item: GridItemForDocument, months: number): { code: string; cents: number } | null {
  const v = item.byMonths.get(months);
  if (!v) return null;
  try {
    return { code: v.code, cents: gridPriceToCents(v.unitPrice) };
  } catch (e) {
    throw new GridLineError('PRICE_PRECISION', (e as Error).message);
  }
}

const missingLabel = (item: GridItemForDocument, o: ProposalChoiceOption) => `${item.code}-${commitmentSuffix(o.commitmentMonths ?? 0)} (${o.label})`;

/** Clé de ligne libre dérivée du code (« m365-0003 », puis « m365-0003-2 »…). */
export function gridLineKey(def: ProposalPricingDefinition, itemCode: string): string {
  const base = itemCode.toLowerCase();
  const used = new Set(def.lines.map((l) => l.key));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function buildGridLine(
  def: ProposalPricingDefinition,
  item: GridItemForDocument,
  opts: { key: string; kind?: 'REQUIRED' | 'OPTIONAL' | 'SETUP'; quantity?: number; on: string },
): ProposalPricingLine {
  if (Number(item.vatRatePercent) !== def.vatRatePercent) {
    throw new GridLineError('VAT_MISMATCH', `TVA du code ${item.code} (${item.vatRatePercent} %) différente de celle de la proposition (${def.vatRatePercent} %).`);
  }
  const choice = commitmentChoiceOf(def);
  const byChoice: Record<string, number> = {};
  const variants: Record<string, string> = {};
  const missing: string[] = [];
  for (const o of choice.options) {
    const c = cents(item, o.commitmentMonths ?? 0);
    if (!c) { missing.push(missingLabel(item, o)); continue; }
    byChoice[o.value] = c.cents;
    variants[o.value] = c.code;
  }
  if (missing.length) {
    throw new GridLineError('MISSING_DURATIONS', `Le code ${item.code} n'a pas de prix pour toutes les durées de la proposition.`, missing);
  }
  const kind = opts.kind ?? (item.recurrence === 'ONE_OFF' ? 'SETUP' : 'REQUIRED');
  const recurrence = RECURRENCE[item.recurrence];
  const group = kind === 'OPTIONAL' ? 'OPTIONS' : recurrence === 'ONE_TIME' ? 'SETUP' : recurrence === 'YEARLY' ? 'YEARLY' : 'RECURRING';
  return {
    key: opts.key,
    label: item.label,
    ...(item.description ? { description: item.description.slice(0, 1000) } : {}),
    kind,
    unit: unitLabel(item.unit),
    recurrence,
    quantity: { default: opts.quantity ?? 1, min: 0, editableByClient: false },
    pricing: { dependsOn: choice.key, byChoice },
    priceStatus: 'VALIDATED',
    priceSource: `Grille tarifaire ${item.code} (prix au ${opts.on})`,
    group,
    grid: { itemCode: item.code, variants, vatRatePercent: item.vatRatePercent, on: opts.on },
  };
}

/**
 * Nouvelles durées proposées (choix d'engagement). `items` : les codes de
 * grille des lignes concernées, lus à `on`. Retourne la définition, ou
 * l'erreur MISSING_DURATIONS listant les versions absentes.
 */
export function changeCommitments(
  def: ProposalPricingDefinition,
  input: { months: readonly number[]; defaultMonths: number; switchGridLines: boolean; on: string },
  labels: ReadonlyMap<number, string>,
  items: ReadonlyMap<string, GridItemForDocument>,
): ProposalPricingDefinition {
  const choice = commitmentChoiceOf(def);
  const months = [...new Set(input.months)].sort((a, b) => a - b);
  const taken = new Set<string>();
  const options: ProposalChoiceOption[] = months.map((m) => {
    const kept = choice.options.find((o) => o.commitmentMonths === m);
    let value = kept?.value ?? String(m);
    while (!kept && taken.has(value)) value = `${value}m`;
    taken.add(value);
    const base: ProposalChoiceOption = kept ?? { value, label: labels.get(m) ?? `${m} mois`, commitmentMonths: m };
    const { default: _d, ...rest } = base;
    return m === input.defaultMonths ? { ...rest, default: true } : rest;
  });
  const oldMonthsOf = new Map(choice.options.map((o) => [o.value, o.commitmentMonths ?? 0] as const));
  const missing: string[] = [];

  const lines = def.lines.map((l): ProposalPricingLine => {
    if (!('dependsOn' in l.pricing) || l.pricing.dependsOn !== choice.key) return l;
    const old = l.pricing.byChoice;
    const oldByMonths = new Map(Object.entries(old).map(([v, c]) => [oldMonthsOf.get(v) ?? -1, c] as const));
    const byChoice: Record<string, number> = {};
    const variants: Record<string, string> = {};
    const item = l.grid ? items.get(l.grid.itemCode) : undefined;
    let fetched = false;
    for (const o of options) {
      const m = o.commitmentMonths!;
      const keptPrice = oldByMonths.get(m);
      const keptValue = choice.options.find((x) => x.commitmentMonths === m)?.value;
      if (l.grid) {
        if (keptPrice !== undefined && !input.switchGridLines && keptValue && l.grid.variants[keptValue]) {
          byChoice[o.value] = keptPrice;
          variants[o.value] = l.grid.variants[keptValue]!;
          continue;
        }
        const c = item ? cents(item, m) : null;
        if (!c) { missing.push(`${l.grid.itemCode}-${commitmentSuffix(m)} (${o.label})`); continue; }
        byChoice[o.value] = c.cents;
        variants[o.value] = c.code;
        fetched = true;
        continue;
      }
      // Ligne hors grille : prix conservé, sinon celui de la durée la plus proche (à valider).
      if (keptPrice !== undefined) { byChoice[o.value] = keptPrice; continue; }
      const nearest = [...oldByMonths].filter(([om]) => om >= 0).sort((a, b) => Math.abs(a[0] - m) - Math.abs(b[0] - m) || a[0] - b[0])[0];
      byChoice[o.value] = nearest ? nearest[1] : 0;
    }
    const next: ProposalPricingLine = {
      ...l,
      pricing: { dependsOn: choice.key, byChoice },
      ...(l.grid ? { grid: { ...l.grid, variants, ...(fetched ? { on: input.on } : {}) } } : {}),
    };
    if (!l.priceStatusByChoice) return next;
    const statuses: Record<string, 'VALIDATED' | 'TO_VALIDATE'> = {};
    for (const o of options) {
      const kv = choice.options.find((x) => x.commitmentMonths === o.commitmentMonths)?.value;
      statuses[o.value] = (kv && l.priceStatusByChoice[kv]) || 'TO_VALIDATE';
    }
    return { ...next, priceStatusByChoice: statuses };
  });
  if (missing.length) {
    throw new GridLineError('MISSING_DURATIONS', 'Des lignes de grille n’ont pas de version pour toutes les durées demandées.', missing);
  }
  return { ...def, choices: def.choices.map((c) => (c.key === choice.key ? { ...c, options } : c)), lines };
}

/**
 * Après `enforcePriceStatuses` (un commercial ne s'auto-valide jamais un
 * prix) : une ligne de grille dont TOUS les prix sont exactement ceux de la
 * grille à sa date de copie est VALIDÉE — la grille est elle-même tenue par
 * l'administrateur (pricing.grid.manage).
 */
export function validateGridPrices(def: ProposalPricingDefinition, items: ReadonlyMap<string, GridItemForDocument>): ProposalPricingDefinition {
  const choice = def.choices.find((x) => x.options.some((o) => o.commitmentMonths !== undefined));
  return {
    ...def,
    lines: def.lines.map((l) => {
      if (!l.grid || !choice || !('dependsOn' in l.pricing) || l.pricing.dependsOn !== choice.key) return l;
      const item = items.get(l.grid.itemCode);
      if (!item) return l;
      const ok = choice.options.every((o) => {
        const c = item.byMonths.get(o.commitmentMonths ?? 0);
        if (!c) return false;
        try {
          return (l.pricing as { byChoice: Record<string, number> }).byChoice[o.value] === gridPriceToCents(c.unitPrice);
        } catch { return false; }
      });
      if (!ok) return l;
      const { priceStatusByChoice: _drop, ...rest } = l;
      return { ...rest, priceStatus: 'VALIDATED' as const };
    }),
  };
}
