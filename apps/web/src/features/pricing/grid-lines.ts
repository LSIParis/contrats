import { decimalToInput } from '../../lib/money.js';
import { unitLabel } from '../contract-kinds/labels.js';
import type { VariantSnapshot } from '../contract-kinds/types.js';
import { emptyDraft, type LineDraft } from './line-draft.js';

/**
 * Lignes de barème issues de la grille tarifaire (13-types-contrats.md §7).
 * Le code de version devient le code article ; libellé, unité, prix et TVA
 * sont COPIÉS dans la ligne (mode MANUAL) : modifier la grille ensuite ne
 * change jamais un barème existant.
 */

const GRID_VARIANT_RE = /^([A-Z0-9]{2,6}-\d{4,})-E(\d{2})$/;

/** Code de version de la grille (« M365-0003-E12 ») → code de base et durée ; sinon null. */
export function parseVariantCode(code: string): { itemCode: string; months: number } | null {
  const m = GRID_VARIANT_RE.exec(code.trim());
  return m ? { itemCode: m[1]!, months: Number(m[2]) } : null;
}

/** Même code de base, autre durée : « M365-0003-E12 », 24 → « M365-0003-E24 ». */
export function switchVariantCode(code: string, months: number): string | null {
  const p = parseVariantCode(code);
  return p ? `${p.itemCode}-E${String(months).padStart(2, '0')}` : null;
}

/** Type de ligne du moteur pour une version de grille. */
function kindOf(v: VariantSnapshot): Pick<LineDraft, 'kind' | 'recurrence'> {
  if (v.recurrence === 'ONE_OFF') return v.unit === 'PER_HOUR' ? { kind: 'HOURLY', recurrence: 'ONE_OFF' } : { kind: 'SETUP_FEE', recurrence: '' };
  if (v.unit === 'FLAT') return { kind: v.recurrence === 'YEARLY' ? 'FLAT_YEARLY' : 'FLAT_MONTHLY', recurrence: '' };
  return { kind: 'UNIT', recurrence: v.recurrence };
}

/** Champs copiés de la grille dans une ligne (création ou bascule de durée). */
export function gridFields(v: VariantSnapshot): Partial<LineDraft> {
  return {
    articleCode: v.code,
    label: v.label,
    description: v.description ?? '',
    unit: unitLabel(v.unit),
    ...kindOf(v),
    mode: 'MANUAL',
    vatRatePercent: decimalToInput(v.vatRatePercent),
    unitPrice: decimalToInput(v.unitPrice),
  };
}

export function draftFromGrid(v: VariantSnapshot, n: number): LineDraft {
  return { ...emptyDraft(n), lineKey: v.code.toLowerCase(), quantity: '1', ...gridFields(v) };
}

/**
 * Lignes de la grille dont la durée diffère de l'engagement du barème
 * (vide = sans engagement = 0 mois, comme à la conversion d'une
 * proposition) : candidates à la bascule.
 */
export function linesToSwitch(drafts: readonly LineDraft[], commitmentMonths: number): number[] {
  return drafts.flatMap((d, i) => {
    const p = parseVariantCode(d.articleCode);
    return p && p.months !== commitmentMonths ? [i] : [];
  });
}
