import { decimalFromInput, decimalToInput } from '../../lib/money.js';
import type { IndexLookup, LineInput, LineKind, PricingMode, Recurrence, TierMode } from './types.js';

/**
 * État de saisie d'une ligne de barème : tous les champs possibles, en
 * chaînes telles que tapées (virgule décimale acceptée). `lineFromDraft`
 * produit EXACTEMENT la forme de `LineInputSchema` (apps/api/src/pricing/
 * pricing.schemas.ts) : seuls les blocs pertinents pour le type et le mode
 * sont envoyés — le schéma est `.strict()` et le moteur refuse les
 * combinaisons incohérentes (ex. révision native sur une formule).
 */
export interface LineDraft {
  lineKey: string;
  articleCode: string;
  label: string;
  unit: string;
  kind: LineKind;
  mode: PricingMode;
  recurrence: '' | Recurrence;
  vatRatePercent: string;
  quantitySource: 'FIXED' | 'PROVIDER';
  quantity: string;
  providerArticleCode: string;
  unitPrice: string;
  tierMode: TierMode;
  tiers: Array<{ upTo: string; unitPrice: string }>;
  priceRuleId: string;
  adjustmentRuleIds: string[];
  expression: string;
  basePrice: string;
  variables: Array<{ name: string; value: string }>;
  indexVariables: Array<{ name: string; indexCode: string; date: string; lookup: '' | IndexLookup }>;
  hasRevision: boolean;
  revIndexCode: string;
  revA: string;
  revB: string;
  revReferenceDate: string;
  revRevisionDate: string;
  revLookup: '' | IndexLookup;
  hoursPerPack: string;
  discountType: 'PERCENT' | 'AMOUNT';
  discountValue: string;
  discountScope: 'SUBTOTAL' | 'LINES';
  discountLineIds: string[];
}

export function emptyDraft(n: number): LineDraft {
  return {
    lineKey: `ligne-${n}`, articleCode: '', label: '', unit: 'mois', kind: 'FLAT_MONTHLY', mode: 'MANUAL', recurrence: '',
    vatRatePercent: '20', quantitySource: 'FIXED', quantity: '1', providerArticleCode: '', unitPrice: '',
    tierMode: 'GRADUATED', tiers: [{ upTo: '', unitPrice: '' }], priceRuleId: '', adjustmentRuleIds: [],
    expression: '', basePrice: '', variables: [], indexVariables: [],
    hasRevision: false, revIndexCode: '', revA: '0,15', revB: '0,85', revReferenceDate: '', revRevisionDate: '', revLookup: '',
    hoursPerPack: '', discountType: 'PERCENT', discountValue: '', discountScope: 'SUBTOTAL', discountLineIds: [],
  };
}

export function draftFromLine(l: LineInput, n = 0): LineDraft {
  const d = emptyDraft(n);
  return {
    ...d,
    lineKey: l.lineKey, articleCode: l.articleCode, label: l.label, unit: l.unit, kind: l.kind, mode: l.mode,
    recurrence: l.recurrence ?? '', vatRatePercent: decimalToInput(l.vatRatePercent),
    quantitySource: l.quantitySource ?? 'FIXED', quantity: decimalToInput(l.quantity ?? (l.quantitySource === 'PROVIDER' ? '' : '1')),
    providerArticleCode: l.providerArticleCode ?? '', unitPrice: decimalToInput(l.unitPrice),
    tierMode: l.tiers?.mode ?? 'GRADUATED',
    tiers: l.tiers ? l.tiers.tiers.map((t) => ({ upTo: decimalToInput(t.upTo), unitPrice: decimalToInput(t.unitPrice) })) : d.tiers,
    priceRuleId: l.rule?.priceRuleId ?? '', adjustmentRuleIds: l.rule?.adjustmentRuleIds ?? [],
    expression: l.formula?.expression ?? '', basePrice: decimalToInput(l.formula?.basePrice),
    variables: Object.entries(l.formula?.variables ?? {}).map(([name, value]) => ({ name, value: decimalToInput(value) })),
    indexVariables: Object.entries(l.formula?.indexVariables ?? {}).map(([name, b]) => ({ name, indexCode: b.indexCode, date: b.date, lookup: b.lookup ?? '' })),
    hasRevision: Boolean(l.revision),
    revIndexCode: l.revision?.indexCode ?? '', revA: l.revision ? decimalToInput(l.revision.a) : d.revA,
    revB: l.revision ? decimalToInput(l.revision.b) : d.revB, revReferenceDate: l.revision?.referenceDate ?? '',
    revRevisionDate: l.revision?.revisionDate ?? '', revLookup: l.revision?.lookup ?? '',
    hoursPerPack: decimalToInput(l.hourPack?.hoursPerPack),
    discountType: l.discount?.type ?? 'PERCENT', discountValue: decimalToInput(l.discount?.value),
    discountScope: l.discount?.appliesTo.scope ?? 'SUBTOTAL',
    discountLineIds: l.discount?.appliesTo.scope === 'LINES' ? l.discount.appliesTo.lineIds : [],
  };
}

/** Lignes dont la révision native est admise (§4.2 : MANUAL ou RULE, pas les remises). */
export const revisionAllowed = (d: Pick<LineDraft, 'kind' | 'mode'>): boolean => d.kind !== 'DISCOUNT' && d.mode !== 'FORMULA';

/** Saisie → `LineInput` ou liste d'erreurs de FORME (les règles de fond restent au moteur). */
export function lineFromDraft(d: LineDraft): { line: LineInput } | { errors: string[] } {
  const errors: string[] = [];
  const who = d.label.trim() || d.lineKey.trim() || 'ligne';
  const decimal = (raw: string, field: string, opts?: { required?: boolean; signed?: boolean; maxFraction?: number }): string | undefined => {
    const v = decimalFromInput(raw, opts);
    if (v === null) errors.push(`${who} : ${field} invalide (nombre attendu, ex. 1250,50).`);
    else if (v === undefined && opts?.required) errors.push(`${who} : ${field} obligatoire.`);
    return v ?? undefined;
  };
  const required = (raw: string, field: string): string => {
    if (!raw.trim()) errors.push(`${who} : ${field} obligatoire.`);
    return raw.trim();
  };

  const isDiscount = d.kind === 'DISCOUNT';
  const mode: PricingMode = isDiscount ? 'MANUAL' : d.mode;
  const line: LineInput = {
    lineKey: required(d.lineKey, 'clé de ligne'),
    articleCode: required(d.articleCode, 'code article'),
    label: required(d.label, 'libellé'),
    unit: required(d.unit, 'unité'),
    kind: d.kind,
    mode,
    vatRatePercent: decimal(d.vatRatePercent, 'taux de TVA', { required: true, maxFraction: 2 }) ?? '',
  };
  if (d.recurrence) line.recurrence = d.recurrence;

  if (!isDiscount) {
    line.quantitySource = d.quantitySource;
    if (d.quantitySource === 'FIXED') {
      const q = decimal(d.quantity, 'quantité');
      if (q !== undefined) line.quantity = q;
    } else {
      line.providerArticleCode = required(d.providerArticleCode, 'article du fournisseur de quantités');
    }
  }

  if (isDiscount) {
    const value = decimal(d.discountValue, 'valeur de la remise', { required: true }) ?? '';
    if (d.discountScope === 'LINES' && d.discountLineIds.length === 0) errors.push(`${who} : choisir au moins une ligne remisée.`);
    line.discount = {
      type: d.discountType,
      value,
      appliesTo: d.discountScope === 'LINES' ? { scope: 'LINES', lineIds: d.discountLineIds } : { scope: 'SUBTOTAL' },
    };
  } else if (mode === 'MANUAL') {
    if (d.kind === 'TIERED') {
      line.tiers = {
        mode: d.tierMode,
        tiers: d.tiers.map((t, i) => ({
          upTo: decimal(t.upTo, `borne du palier ${i + 1}`) ?? null,
          unitPrice: decimal(t.unitPrice, `prix du palier ${i + 1}`, { required: true }) ?? '',
        })),
      };
    } else {
      const p = decimal(d.unitPrice, 'prix unitaire', { required: true });
      if (p !== undefined) line.unitPrice = p;
    }
  } else if (mode === 'RULE') {
    line.rule = { priceRuleId: required(d.priceRuleId, 'règle de prix') };
    if (d.adjustmentRuleIds.length) line.rule.adjustmentRuleIds = d.adjustmentRuleIds;
  } else {
    const formula: NonNullable<LineInput['formula']> = { expression: required(d.expression, 'expression') };
    const base = decimal(d.basePrice, 'prix de base');
    if (base !== undefined) formula.basePrice = base;
    const vars = d.variables.filter((v) => v.name.trim());
    if (vars.length) {
      formula.variables = Object.fromEntries(
        vars.map((v) => [v.name.trim(), decimal(v.value, `variable ${v.name.trim()}`, { required: true, signed: true, maxFraction: 10 }) ?? '']),
      );
    }
    const ivars = d.indexVariables.filter((v) => v.name.trim());
    if (ivars.length) {
      formula.indexVariables = Object.fromEntries(
        ivars.map((v) => [
          v.name.trim(),
          { indexCode: required(v.indexCode, `indice de ${v.name.trim()}`), date: required(v.date, `date de ${v.name.trim()}`), ...(v.lookup ? { lookup: v.lookup } : {}) },
        ]),
      );
    }
    line.formula = formula;
  }

  if (d.hasRevision && revisionAllowed({ kind: d.kind, mode })) {
    line.revision = {
      indexCode: required(d.revIndexCode, 'indice de révision'),
      a: decimal(d.revA, 'coefficient a', { required: true }) ?? '',
      b: decimal(d.revB, 'coefficient b', { required: true }) ?? '',
      referenceDate: required(d.revReferenceDate, 'date de référence (S0)'),
      revisionDate: required(d.revRevisionDate, 'date de révision (S1)'),
      ...(d.revLookup ? { lookup: d.revLookup } : {}),
    };
  }
  if (d.kind === 'HOUR_PACK') line.hourPack = { hoursPerPack: decimal(d.hoursPerPack, 'heures par pack', { required: true }) ?? '' };

  return errors.length ? { errors } : { line };
}
