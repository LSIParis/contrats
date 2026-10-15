import { formatDecimal } from '../../lib/money.js';
import type { GridRecurrence, PriceUnitCode } from './types.js';

/**
 * Libellés des types de contrats et grilles tarifaires.
 *
 * Copie des référentiels de `@lsi/domain` (packages/domain/src/price-grid/price-grid.ts,
 * PRICE_UNITS et GRID_RECURRENCES) : l'application web ne dépend pas de ce paquet.
 * Garder les deux listes alignées.
 */
export const PRICE_UNITS: ReadonlyArray<{ code: PriceUnitCode; label: string }> = [
  { code: 'PER_USER', label: 'par utilisateur' },
  { code: 'PER_DEVICE', label: 'par poste' },
  { code: 'PER_LICENSE', label: 'par licence' },
  { code: 'PER_UNIT', label: "à l'unité" },
  { code: 'FLAT', label: 'forfait' },
  { code: 'PER_HOUR', label: 'heure' },
];

export const GRID_RECURRENCES: ReadonlyArray<{ code: GridRecurrence; label: string }> = [
  { code: 'MONTHLY', label: 'mensuelle' },
  { code: 'YEARLY', label: 'annuelle' },
  { code: 'ONE_OFF', label: 'ponctuelle' },
];

/** Préfixe d'un type : 2 à 6 caractères, majuscules et chiffres (CHECK en base). */
export const KIND_PREFIX_RE = /^[A-Z0-9]{2,6}$/;

/** Durées d'engagement : 0 (sans engagement) à 99 mois — deux chiffres dans les codes. */
export const MAX_COMMITMENT_MONTHS = 99;

export const unitLabel = (code: string): string => PRICE_UNITS.find((u) => u.code === code)?.label ?? code;
export const recurrenceLabel = (code: string): string => GRID_RECURRENCES.find((r) => r.code === code)?.label ?? code;

/** Suffixe de durée dans les codes : 12 → « E12 ». */
export const commitmentSuffix = (months: number): string => `E${String(months).padStart(2, '0')}`;

/** « 35.5 » → « 35,50 € » ; null → « — ». */
export const euros = (dec: string | null | undefined): string => {
  const f = formatDecimal(dec ?? null);
  return f === '—' ? f : `${f} €`;
};

/** « 2026-10-15 » → « 15/10/2026 ». */
export const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—';

/** Date du jour au format AAAA-MM-JJ (fuseau du navigateur). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
