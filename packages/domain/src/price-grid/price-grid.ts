/**
 * Types de contrats et grilles tarifaires par durée d'engagement
 * (docs/contrats/13-types-contrats.md).
 *
 * Règles pures, partagées par l'API, le seed et l'interface. La base reste
 * l'autorité sur les codes (triggers de la migration 34) : les fonctions de
 * format ci-dessous produisent EXACTEMENT ce que la base calcule, pour
 * l'aperçu, l'import CSV et la bascule de durée — jamais pour attribuer.
 *
 * Aucun traitement propre à un type prédéfini : un type créé par l'utilisateur
 * suit les mêmes règles.
 */

/** Préfixe d'un type : 2 à 6 caractères, majuscules et chiffres (CHECK en base). */
export const CONTRACT_KIND_PREFIX_RE = /^[A-Z0-9]{2,6}$/;

export function isValidContractKindPrefix(prefix: string): boolean {
  return CONTRACT_KIND_PREFIX_RE.test(prefix);
}

/** Unités d'une ligne de grille. Le code est stocké ; le libellé est affiché. */
export const PRICE_UNITS = [
  { code: 'PER_USER', label: 'par utilisateur' },
  { code: 'PER_DEVICE', label: 'par poste' },
  { code: 'PER_LICENSE', label: 'par licence' },
  { code: 'PER_UNIT', label: "à l'unité" },
  { code: 'FLAT', label: 'forfait' },
  { code: 'PER_HOUR', label: 'heure' },
] as const;
export type PriceUnitCode = (typeof PRICE_UNITS)[number]['code'];
export const PRICE_UNIT_CODES = PRICE_UNITS.map((u) => u.code) as [PriceUnitCode, ...PriceUnitCode[]];

/** Périodicités de facturation d'une ligne de grille (sous-ensemble de PricingRecurrence). */
export const GRID_RECURRENCES = [
  { code: 'MONTHLY', label: 'mensuelle' },
  { code: 'YEARLY', label: 'annuelle' },
  { code: 'ONE_OFF', label: 'ponctuelle' },
] as const;
export type GridRecurrence = (typeof GRID_RECURRENCES)[number]['code'];
export const GRID_RECURRENCE_CODES = GRID_RECURRENCES.map((r) => r.code) as [GridRecurrence, ...GridRecurrence[]];

/** Durées d'engagement : 0 (sans engagement) à 99 mois — deux chiffres dans les codes. */
export const MAX_COMMITMENT_MONTHS = 99;

export function commitmentSuffix(months: number): string {
  if (!Number.isInteger(months) || months < 0 || months > MAX_COMMITMENT_MONTHS) {
    throw new RangeError(`Durée d'engagement invalide : ${months} (0 à ${MAX_COMMITMENT_MONTHS} mois).`);
  }
  return `E${String(months).padStart(2, '0')}`;
}

/** Code de base `{PREFIXE}-{NNNN}`. */
export function formatGridItemCode(prefix: string, n: number): string {
  if (!isValidContractKindPrefix(prefix)) throw new RangeError(`Préfixe invalide : ${prefix}`);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Numéro de code invalide : ${n}`);
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/** Code de version `{PREFIXE}-{NNNN}-E{DD}`. */
export function formatGridVariantCode(itemCode: string, months: number): string {
  return `${itemCode}-${commitmentSuffix(months)}`;
}

export interface ParsedGridCode {
  readonly prefix: string;
  readonly number: number;
  readonly itemCode: string;
  /** Présent pour un code de version. */
  readonly months?: number;
}

const GRID_CODE_RE = /^([A-Z0-9]{2,6})-(\d{4,})(?:-E(\d{2}))?$/;

export function parseGridCode(code: string): ParsedGridCode | null {
  const m = GRID_CODE_RE.exec(code);
  if (!m) return null;
  const [, prefix, num, months] = m as unknown as [string, string, string, string | undefined];
  const n = Number(num);
  if (n < 1) return null;
  return { prefix, number: n, itemCode: `${prefix}-${num}`, ...(months !== undefined ? { months: Number(months) } : {}) };
}

/**
 * Code de la version de MÊME code de base pour une autre durée : bascule des
 * lignes d'un document quand sa durée change. `null` si `code` n'est pas un
 * code de grille.
 */
export function switchVariantCode(code: string, months: number): string | null {
  const p = parseGridCode(code);
  return p ? formatGridVariantCode(p.itemCode, months) : null;
}

export interface DatedPrice {
  readonly id: string;
  /** « AAAA-MM-JJ ». */
  readonly effectiveFrom: string;
}

/**
 * Prix en vigueur à `onDate` (« AAAA-MM-JJ ») : plus grande date d'effet
 * ≤ onDate, puis dernière saisie (id uuidv7 croissant). `null` si aucun.
 */
export function priceInEffect<P extends DatedPrice>(prices: readonly P[], onDate: string): P | null {
  let best: P | null = null;
  for (const p of prices) {
    if (p.effectiveFrom > onDate) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom || (p.effectiveFrom === best.effectiveFrom && p.id > best.id)) best = p;
  }
  return best;
}

/**
 * Prix décimal en euros (« 12.5 », « 4.125000 ») → centimes entiers, pour
 * les propositions (montants en centimes). Refuse plus de 2 décimales
 * significatives : arrondir changerait le prix de la grille en silence.
 */
export function gridPriceToCents(price: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!m) throw new RangeError(`Prix invalide : ${price}`);
  const decimals = (m[2] ?? '').replace(/0+$/, '');
  if (decimals.length > 2) {
    throw new RangeError(`Prix ${price} : plus de 2 décimales, inutilisable dans une proposition (montants au centime).`);
  }
  return Number(m[1]) * 100 + Number(decimals.padEnd(2, '0'));
}
