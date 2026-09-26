/**
 * Briques d'analyse du français contractuel, partagées par l'extraction.
 *
 * Tout travaille sur un texte OCR « réparé » de MÊME LONGUEUR que l'original
 * (`repairOcr`) : les positions trouvées restent valables dans le texte source,
 * donc l'extrait cité en preuve (`evidence`) est exactement ce que
 * l'utilisateur verra surligné dans le PDF texte.
 */

/**
 * Corrige les confusions OCR classiques SANS changer la longueur du texte
 * (substitutions caractère pour caractère uniquement) :
 *
 * - dans un « mot numérique » — suite de chiffres, de O/o/l/I/| et de
 *   séparateurs `.` `,` contenant AU MOINS un vrai chiffre et non collée à une
 *   lettre — O/o → 0 et l/I/| → 1 (« 2O24 » → « 2024 », « 3OO,OO » → « 300,00 »,
 *   « l5 mars » → « 15 mars ») ; « Art1cle » ou « Il » ne sont pas touchés ;
 * - espaces insécables → espaces, apostrophes typographiques → '.
 */
export function repairOcr(text: string): string {
  return text
    .replace(/[  ]/g, ' ')
    .replace(/[’‘`]/g, "'")
    .replace(/(?<![\p{L}])[0-9OolI|][0-9OolI|.,]*(?![\p{L}])/gu, (word) =>
      /\d/.test(word) ? word.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1') : word,
    );
}

/** Minuscules sans accents, MÊME LONGUEUR (les diacritiques combinants sont rares après NFC). */
export function foldSameLength(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += (base.length === ch.length ? base : ch).toLowerCase();
  }
  return out.length === text.length ? out : text.toLowerCase();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: readonly [RegExp, number][] = [
  [/^(?:janv?|ianv?|janvier|ianvier)/, 1],
  [/^(?:fev|fevr|fevrier)/, 2],
  [/^mars$/, 3],
  [/^(?:avr|avril)/, 4],
  [/^mai$/, 5],
  [/^juin$/, 6],
  [/^(?:juil|juillet)/, 7],
  [/^(?:aout|aou)/, 8],
  [/^(?:sept?|septembre)/, 9],
  [/^(?:oct|octobre)/, 10],
  [/^(?:nov|novembre)/, 11],
  [/^(?:dec|decembre)/, 12],
];

/** Mois écrits (texte déjà replié : minuscules sans accents). */
export const MONTH_WORD =
  '(?:janvier|ianvier|janv\\.?|fevrier|fevr?\\.?|mars|avril|avr\\.?|mai|juin|juillet|juil\\.?|aout|septembre|sept?\\.?|octobre|oct\\.?|novembre|nov\\.?|decembre|dec\\.?)';

/** « 1er janvier 2024 », « 1 janv. 2024 », « 01/01/2024 », « 1.1.24 », « 2024-01-01 ». */
export const DATE_RE = new RegExp(
  [
    `(?<![\\p{L}\\d])(\\d{1,2})\\s*(?:er|ᵉʳ|°)?\\s+(${MONTH_WORD})\\s+(\\d{4})(?!\\d)`,
    `(?<![\\d/.-])(\\d{1,2})\\s?[/.-]\\s?(\\d{1,2})\\s?[/.-]\\s?(\\d{4}|\\d{2})(?![\\d/.-]*\\d)`,
    `(?<!\\d)(\\d{4})-(\\d{2})-(\\d{2})(?!\\d)`,
  ].join('|'),
  'gu',
);

function monthFromWord(word: string): number | null {
  const w = word.replace(/\./g, '');
  for (const [re, n] of MONTHS) if (re.test(w)) return n;
  return null;
}

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface FoundDate {
  readonly iso: string;
  readonly index: number;
  readonly length: number;
}

/** Toutes les dates d'un texte replié, dans l'ordre. Les dates impossibles sont ignorées. */
export function findDates(folded: string): FoundDate[] {
  const out: FoundDate[] = [];
  DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_RE.exec(folded)) !== null) {
    let iso: string | null = null;
    if (m[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      const month = monthFromWord(m[2]);
      if (month) iso = isoDate(Number(m[3]), month, Number(m[1]));
    } else if (m[4] !== undefined && m[5] !== undefined && m[6] !== undefined) {
      let y = Number(m[6]);
      if (m[6].length === 2) y += y >= 70 ? 1900 : 2000;
      iso = isoDate(y, Number(m[5]), Number(m[4]));
    } else if (m[7] !== undefined && m[8] !== undefined && m[9] !== undefined) {
      iso = isoDate(Number(m[7]), Number(m[8]), Number(m[9]));
    }
    if (iso && Number(iso.slice(0, 4)) >= 1950 && Number(iso.slice(0, 4)) <= 2100) {
      out.push({ iso, index: m.index, length: m[0].length });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nombres écrits en lettres (durées, préavis)
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  quinze: 15,
  dixhuit: 18,
  vingt: 20,
  vingtquatre: 24,
  trente: 30,
  trentesix: 36,
  quarantehuit: 48,
  soixante: 60,
  quatrevingtdix: 90,
  cent: 100,
  centvingt: 120,
  centquatrevingt: 180,
};

/**
 * Quantité : chiffres, lettres, ou les deux (« trois (3) », « 3 (trois) »).
 * Les chiffres entre parenthèses font foi, comme en pratique notariale.
 */
export const QUANTITY =
  "(\\d{1,3}|(?:[a-z]+(?:[- ](?:et[- ])?[a-z]+){0,2}))(?:\\s*\\(\\s*(\\d{1,3}|[a-z-]+)\\s*\\))?";

export function parseQuantity(main: string | undefined, paren: string | undefined): number | null {
  const asNumber = (s: string | undefined): number | null => {
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    const key = s.replace(/[- ]|et/g, '');
    return NUMBER_WORDS[key] ?? null;
  };
  if (paren && /^\d+$/.test(paren)) return Number(paren);
  return asNumber(main) ?? asNumber(paren);
}

// ---------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------

/** Montant en euros (texte replié). Groupe 1 : le nombre. */
export const EURO_AMOUNT_RE =
  /(?<![\d.,])(\d{1,3}(?:[ .]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:€|eur(?![a-z])|euros?(?![a-z]))/gu;

/** « 1 250,00 » / « 1.250 » / « 1250.5 » → centimes. */
export function parseEuroCents(raw: string): number | null {
  let s = raw.replace(/\s/g, '');
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
}
