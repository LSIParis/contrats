/**
 * Pseudonymisation du texte envoyé à un fournisseur d'IA externe (brief §6, §10).
 *
 * Règle : AUCUN nom de client, SIREN/SIRET, n° de TVA, adresse, e-mail,
 * téléphone, IBAN, nom de personne ni MONTANT RÉEL ne quitte le serveur. Ils
 * sont remplacés par des jetons stables (`[CLIENT]`, `[SIREN_1]`,
 * `[MONTANT_1]`…) que l'on réinjecte localement une fois la réponse reçue.
 *
 * Fonctions PURES : pas d'horloge, pas d'aléa, pas d'E/S. Même entrée → même
 * sortie, ce qui rend le comportement testable ET auditable (on peut rejouer
 * la pseudonymisation d'une requête archivée et retrouver exactement le texte
 * envoyé).
 *
 * Deux sources de détection, cumulées :
 *
 * 1. Les ENTITÉS CONNUES (`KnownEntities`) : ce que l'appelant sait du client
 *    (raison sociale, SIREN, contacts…). Recherche tolérante à la casse, aux
 *    accents, aux espaces et aux séparateurs de chiffres, mais bornée aux mots
 *    entiers (« Acme » ne touche pas « Acmesoft »).
 * 2. Les MOTIFS détectables sans connaissance préalable : e-mails, IBAN, TVA
 *    intracommunautaire, téléphones français, SIREN/SIRET (groupes de 9 ou 14
 *    chiffres isolés), montants en euros, adresses postales introduites par un
 *    type de voie, noms précédés d'une civilité ou de « représentée par ».
 *
 * La sur-pseudonymisation est un défaut ACCEPTÉ (un « 40 € » légal devient
 * `[MONTANT_2]` et revient intact à la réidentification) ; la fuite ne l'est
 * pas. D'où `assertNoLeak`, garde-fou que l'adaptateur appelle juste avant
 * l'envoi : il lève si une valeur sensible a survécu.
 *
 * Réversibilité : `reidentify(pseudonymize(t).text, map) === t` tant qu'une
 * même entité n'apparaît que sous une seule graphie. Deux graphies d'une même
 * entité (« ACME » / « Acme ») partagent UN jeton — c'est voulu, le modèle doit
 * voir un seul client — et la réidentification restitue la première graphie
 * rencontrée.
 */

/** Ce que l'appelant sait des données sensibles du dossier. Tout est facultatif. */
export interface KnownEntities {
  /** Raison sociale, nom commercial, sigle… Le premier devient `[CLIENT]`. */
  readonly clientNames?: readonly string[];
  /** Noms de personnes physiques (signataires, contacts). */
  readonly persons?: readonly string[];
  /** SIREN (9 chiffres) ou SIRET (14 chiffres) ; le SIREN d'un SIRET est dérivé. */
  readonly sirens?: readonly string[];
  /** N° de TVA intracommunautaire ; le SIREN qu'il contient est dérivé. */
  readonly vatNumbers?: readonly string[];
  readonly addresses?: readonly string[];
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly ibans?: readonly string[];
  /** Montants sous une forme que les motifs ne reconnaissent pas (ex. en lettres). */
  readonly amounts?: readonly string[];
}

export const PSEUDONYM_KINDS = [
  'CLIENT',
  'PERSONNE',
  'SIREN',
  'SIRET',
  'TVA',
  'ADRESSE',
  'EMAIL',
  'TEL',
  'IBAN',
  'MONTANT',
] as const;

export type PseudonymKind = (typeof PSEUDONYM_KINDS)[number];

/** Jeton → valeur d'origine. Ne quitte JAMAIS le serveur. */
export type PseudonymizationMap = Readonly<Record<string, string>>;

export interface PseudonymizationResult {
  readonly text: string;
  readonly map: PseudonymizationMap;
}

export interface PseudonymizeOptions {
  /**
   * Table issue d'un appel précédent, à prolonger. Permet de pseudonymiser
   * plusieurs champs d'une même requête (besoin, services, clauses du modèle)
   * avec des jetons cohérents : « Acme » est `[CLIENT]` partout.
   */
  readonly map?: PseudonymizationMap;
}

/** Une fuite détectée. Ne contient PAS la valeur : elle finirait dans les journaux. */
export interface LeakReport {
  readonly kind: PseudonymKind;
  readonly source: 'known' | 'pattern';
  readonly offset: number;
}

export class PseudonymizationLeakError extends Error {
  readonly leaks: readonly LeakReport[];

  constructor(leaks: readonly LeakReport[]) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(', ');
    super(
      `Pseudonymisation incomplète : ${leaks.length} valeur(s) sensible(s) détectée(s) (${kinds}). Envoi refusé.`,
    );
    this.name = 'PseudonymizationLeakError';
    this.leaks = leaks;
  }
}

/** Forme d'un jeton. Tout ce qui correspond est protégé des passes suivantes. */
const TOKEN_RE = /\[(?:CLIENT|PERSONNE|SIREN|SIRET|TVA|ADRESSE|EMAIL|TEL|IBAN|MONTANT)(?:_\d+)?\]/g;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Minuscules, sans diacritiques, espaces et apostrophes unifiés. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[\s  ]+/g, ' ')
    .trim()
    .toLowerCase();
}

function alnumUpper(s: string): string {
  return s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function phoneKey(s: string): string {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('0033')) d = '0' + d.slice(4);
  else if (d.startsWith('33') && d.length === 11) d = '0' + d.slice(2);
  // +33 (0)1 … → 0033 0 1… : on retire le zéro doublé.
  if (d.startsWith('00') && d.length === 11) d = d.slice(1);
  return d;
}

/** Clé d'identité d'une valeur : deux graphies d'une même entité ont la même clé. */
function keyOf(kind: PseudonymKind, value: string): string {
  switch (kind) {
    case 'SIREN':
    case 'SIRET':
    case 'IBAN':
    case 'TVA':
      return alnumUpper(value);
    case 'TEL':
      return phoneKey(value);
    case 'EMAIL':
      return value.trim().toLowerCase();
    case 'CLIENT':
    case 'PERSONNE':
      // Un même nom peut être connu comme client ET comme personne : une seule clé.
      // « Jean-Pierre » et « Jean Pierre » désignent la même personne.
      return 'NOM:' + fold(value.replace(/[-‐‑–]/g, ' '));
    default:
      return fold(value);
  }
}

// ---------------------------------------------------------------------------
// Construction des motifs pour les entités connues
// ---------------------------------------------------------------------------

const ACCENT_CLASSES: Record<string, string> = {
  a: 'aàâäáãå',
  c: 'cç',
  e: 'eéèêë',
  i: 'iîïíì',
  o: 'oôöóòõ',
  u: 'uùûüú',
  y: 'yÿý',
  n: 'nñ',
};

const SPACE = '[\\s\\u00A0\\u202F]';
const DIGIT_SEP = '[\\s\\u00A0\\u202F.\\-]?';

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Motif d'un texte (nom, adresse) tolérant accents, casse, espaces, tirets. */
function textPattern(value: string): string {
  const out: string[] = [];
  const chars = [...value.normalize('NFC').trim()];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (/[\s  ]/.test(ch)) {
      // Un bloc d'espaces = un séparateur souple (retours à la ligne OCR inclus).
      while (i + 1 < chars.length && /[\s  ]/.test(chars[i + 1] as string)) i++;
      out.push(`${SPACE}+`);
      continue;
    }
    if (/['’‘`]/.test(ch)) {
      out.push("['’‘`]");
      continue;
    }
    if (/[-‐‑–]/.test(ch)) {
      out.push(`(?:[-‐‑–]|${SPACE})+`);
      continue;
    }
    if (ch === '.') {
      out.push('\\.?');
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const cls = ACCENT_CLASSES[base];
    out.push(cls ? `[${cls}]` : escapeRe(ch));
  }
  return out.join('');
}

/** Motif d'un identifiant alphanumérique (SIREN, IBAN…) tolérant les séparateurs. */
function digitsPattern(value: string): string {
  return [...alnumUpper(value)].map(escapeRe).join(DIGIT_SEP);
}

/** Motif d'un téléphone connu : forme nationale OU internationale (+33 / 0033). */
function phonePattern(value: string): string {
  const d = phoneKey(value);
  if (/^0[1-9]\d{8}$/.test(d)) {
    const rest = [...d.slice(1)].join(DIGIT_SEP);
    return `(?:0${DIGIT_SEP}|(?:\\+|00)${SPACE}?33${DIGIT_SEP}(?:\\(0\\)${DIGIT_SEP})?)${rest}`;
  }
  return digitsPattern(value);
}

const WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_AFTER = '(?![\\p{L}\\p{N}])';
const NUM_BEFORE = '(?<![\\p{L}\\p{N}])';
const NUM_AFTER = '(?![\\p{N}])';

interface KnownValue {
  readonly kind: PseudonymKind;
  readonly value: string;
  readonly re: RegExp;
}

function clean(list: readonly string[] | undefined, min: number): string[] {
  return (list ?? []).map((v) => v.trim()).filter((v) => fold(v).length >= min);
}

/** Liste ordonnée des valeurs connues, avec les dérivations (SIREN d'un SIRET / d'une TVA). */
function knownValues(k: KnownEntities): Record<'email' | 'iban' | 'tva' | 'amount' | 'tel' | 'id' | 'address' | 'name', KnownValue[]> {
  const mk = (kind: PseudonymKind, value: string, pattern: string, numeric: boolean): KnownValue => ({
    kind,
    value,
    re: new RegExp(
      (numeric ? NUM_BEFORE : WORD_BEFORE) + `(?:${pattern})` + (numeric ? NUM_AFTER : WORD_AFTER),
      'giu',
    ),
  });

  const ids: KnownValue[] = [];
  const seenIds = new Set<string>();
  const addId = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    const kind: PseudonymKind = digits.length === 14 ? 'SIRET' : 'SIREN';
    if (digits.length < 9 || seenIds.has(digits)) return;
    seenIds.add(digits);
    ids.push(mk(kind, raw, digitsPattern(digits), true));
  };
  for (const s of clean(k.sirens, 9)) {
    addId(s);
    const d = s.replace(/\D/g, '');
    if (d.length === 14) addId(d.slice(0, 9));
  }
  for (const t of clean(k.vatNumbers, 9)) {
    const d = t.replace(/\D/g, '');
    if (d.length === 11) addId(d.slice(2));
  }
  // SIRET avant SIREN : le SIREN est un préfixe du SIRET.
  ids.sort((a, b) => alnumUpper(b.value).length - alnumUpper(a.value).length);

  const byLengthDesc = (a: KnownValue, b: KnownValue) => b.value.length - a.value.length;

  const names = [
    ...clean(k.clientNames, 2).map((v) => mk('CLIENT', v, textPattern(v), false)),
    ...clean(k.persons, 2).map((v) => mk('PERSONNE', v, textPattern(v), false)),
  ].sort(byLengthDesc);

  return {
    email: clean(k.emails, 3).map((v) => mk('EMAIL', v, textPattern(v), false)),
    iban: clean(k.ibans, 5).map((v) => mk('IBAN', v, digitsPattern(v), false)),
    tva: clean(k.vatNumbers, 5).map((v) => mk('TVA', v, digitsPattern(v), false)),
    amount: clean(k.amounts, 1).map((v) => mk('MONTANT', v, textPattern(v), false)).sort(byLengthDesc),
    tel: clean(k.phones, 6).map((v) => mk('TEL', v, phonePattern(v), true)),
    id: ids,
    address: clean(k.addresses, 5).map((v) => mk('ADRESSE', v, textPattern(v), false)).sort(byLengthDesc),
    name: names,
  };
}

// ---------------------------------------------------------------------------
// Motifs détectables sans connaissance préalable
// ---------------------------------------------------------------------------

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

/** TVA FR : clé de 2 caractères + SIREN. Avant l'IBAN (une TVA ressemble à un IBAN court). */
const TVA_RE = /(?<![\p{L}\p{N}])FR[\s ]?[0-9A-HJ-NP-Z]{2}[\s ]?\d{3}[\s ]?\d{3}[\s ]?\d{3}(?![\s ]?[\p{L}\p{N}])/gu;

const IBAN_RE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[\s ]?[A-Z0-9]{4}){2,7}(?:[\s ]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;

/**
 * Montant en euros : « 1 250,00 € », « 1.250 EUR », « 1250 euros », « 15 k€ »,
 * « € 1 250 ». HT/TTC restent HORS du jeton : le modèle doit savoir qu'un
 * montant est hors taxes, pas combien il vaut.
 */
const AMOUNT_NUM = '(?:\\d{1,3}(?:[ \\u00A0\\u202F.]\\d{3})+|\\d+)(?:,\\d{1,2}|\\.\\d{1,2}(?!\\d))?';
const AMOUNT_RE = new RegExp(
  `(?<![\\p{N}.,])(?:${AMOUNT_NUM}[\\s\\u00A0\\u202F]?(?:[kK][\\s\\u00A0]?)?(?:€|EUR(?!\\p{L})|[Ee]uros?(?!\\p{L}))|€[\\s\\u00A0\\u202F]?${AMOUNT_NUM}(?![\\p{N}]))`,
  'gu',
);

const TEL_RE = new RegExp(
  `(?<![\\p{N}+])(?:(?:\\+|00)${SPACE}?33${DIGIT_SEP}(?:\\(0\\)${DIGIT_SEP})?[1-9]|0[1-9])(?:${DIGIT_SEP}\\d{2}){4}(?!\\p{N})`,
  'gu',
);

const ID_SEP = '[\\s\\u00A0\\u202F.]?';
const SIRET_RE = new RegExp(
  `(?<!\\p{N}${ID_SEP})\\d{3}${ID_SEP}\\d{3}${ID_SEP}\\d{3}${ID_SEP}\\d{5}(?!${ID_SEP}\\p{N})`,
  'gu',
);
const SIREN_RE = new RegExp(`(?<!\\p{N}${ID_SEP})\\d{3}${ID_SEP}\\d{3}${ID_SEP}\\d{3}(?!${ID_SEP}\\p{N})`, 'gu');

/**
 * Adresse : numéro + type de voie + nom de voie, jusqu'à un séparateur
 * (virgule, point-virgule, fin de ligne, code postal). Le code postal et la
 * ville qui suivent sont absorbés par `CITY_TAIL_RE`.
 */
const STREET_TYPES =
  'rue|avenue|av\\.|boulevard|bd|place|pl\\.|all[ée]e|chemin|impasse|quai|route|cours|square|voie|rond-point|faubourg|passage|parvis|esplanade|lieu-dit|zone|za|zi|zac|parc|r[ée]sidence|hameau|sentier|villa|cit[ée]';
const STREET_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d{1,4}(?:${SPACE}?(?:bis|ter|b|t)(?![\\p{L}]))?,?${SPACE}+(?:${STREET_TYPES})(?![\\p{L}])[^\\n,;:()\\[\\]]{1,60}?(?=${SPACE}*(?:[,;\\n(]|\\d{5}(?!\\d)|$)|\\.(?:\\s|$))`,
  'giu',
);
const CITY_TAIL_RE = new RegExp(
  `,?${SPACE}*\\d{5}${SPACE}+\\p{Lu}[\\p{L}'’\\-]*(?:[ \\-](?!CEDEX)\\p{Lu}[\\p{L}'’\\-]*)*(?:${SPACE}+CEDEX(?:${SPACE}+\\d{1,2})?)?`,
  'uy',
);

/** Nom propre : 1 à 3 mots capitalisés (le groupe capturé est la fin du motif). */
const PROPER_NAME = "\\p{Lu}[\\p{L}'’\\-]+(?:[\\s\\u00A0]+\\p{Lu}[\\p{L}'’\\-]+){0,2}";
const CIVILITY_RE = new RegExp(
  `(?<![\\p{L}])(?:M\\.|MM\\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Ma[îi]tre|Me|Dr|Docteur)\\.?[\\s\\u00A0]+(${PROPER_NAME})`,
  'gu',
);
const REPRESENTED_RE = new RegExp(
  `(?<![\\p{L}])[Rr]epr[ée]sent[ée]e?s?[\\s\\u00A0]+par[\\s\\u00A0]+(\\p{Lu}[\\p{L}'’\\-]+(?:[\\s\\u00A0]+\\p{Lu}[\\p{L}'’\\-]+){1,2})`,
  'gu',
);

// ---------------------------------------------------------------------------
// Moteur : passes successives, jamais à l'intérieur d'un jeton
// ---------------------------------------------------------------------------

interface Hit {
  /** Début de la partie remplacée, dans le segment. */
  readonly start: number;
  readonly end: number;
  readonly kind: PseudonymKind;
  readonly source: 'known' | 'pattern';
}

type Finder = (segment: string) => Hit[];

function regexFinder(re: RegExp, kind: PseudonymKind, source: 'known' | 'pattern', group = false): Finder {
  return (segment) => {
    const hits: Hit[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const end = m.index + m[0].length;
      // Le groupe capturé est toujours le SUFFIXE du motif (civilité + nom).
      const start = group && m[1] ? end - m[1].length : m.index;
      hits.push({ start, end, kind, source });
    }
    return hits;
  };
}

function addressFinder(): Finder {
  const street = regexFinder(STREET_RE, 'ADRESSE', 'pattern');
  return (segment) =>
    street(segment).map((h) => {
      CITY_TAIL_RE.lastIndex = h.end;
      const tail = CITY_TAIL_RE.exec(segment);
      return tail ? { ...h, end: h.end + tail[0].length } : h;
    });
}

/** Passes, dans l'ordre. L'ordre compte : voir les commentaires. */
function buildPasses(known: KnownEntities): Finder[] {
  const kv = knownValues(known);
  const fromKnown = (list: KnownValue[]) => list.map((v) => regexFinder(v.re, v.kind, 'known'));
  return [
    // 1. E-mails d'abord : ils contiennent souvent le nom du client ou d'une personne.
    ...fromKnown(kv.email),
    regexFinder(EMAIL_RE, 'EMAIL', 'pattern'),
    // 2. IBAN / TVA avant les montants et identifiants (longues suites de chiffres).
    ...fromKnown(kv.iban),
    ...fromKnown(kv.tva),
    regexFinder(TVA_RE, 'TVA', 'pattern'),
    regexFinder(IBAN_RE, 'IBAN', 'pattern'),
    // 3. Montants avant SIREN : « 125 000 000 € » n'est pas un SIREN.
    ...fromKnown(kv.amount),
    regexFinder(AMOUNT_RE, 'MONTANT', 'pattern'),
    // 4. Téléphones, puis SIRET avant SIREN (préfixe).
    ...fromKnown(kv.tel),
    regexFinder(TEL_RE, 'TEL', 'pattern'),
    ...fromKnown(kv.id),
    regexFinder(SIRET_RE, 'SIRET', 'pattern'),
    regexFinder(SIREN_RE, 'SIREN', 'pattern'),
    // 5. Adresses (connues, puis motif).
    ...fromKnown(kv.address),
    addressFinder(),
    // 6. Noms connus (le plus long d'abord : « Dupont SAS » avant « Dupont »),
    //    puis noms introduits par une civilité.
    ...fromKnown(kv.name),
    regexFinder(CIVILITY_RE, 'PERSONNE', 'pattern', true),
    regexFinder(REPRESENTED_RE, 'PERSONNE', 'pattern', true),
  ];
}

/** Découpe le texte en segments « libres » et « jetons » ; les passes ne voient que les libres. */
function splitOnTokens(text: string): { value: string; token: boolean; offset: number }[] {
  const parts: { value: string; token: boolean; offset: number }[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ value: text.slice(last, m.index), token: false, offset: last });
    parts.push({ value: m[0], token: true, offset: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ value: text.slice(last), token: false, offset: last });
  return parts;
}

class TokenTable {
  readonly map: Record<string, string> = {};
  private readonly byKey = new Map<string, string>();
  private readonly counters = new Map<PseudonymKind, number>();

  constructor(initial?: PseudonymizationMap) {
    for (const [token, value] of Object.entries(initial ?? {})) {
      const m = /^\[([A-Z]+)(?:_(\d+))?\]$/.exec(token);
      if (!m) continue;
      const kind = m[1] as PseudonymKind;
      if (!(PSEUDONYM_KINDS as readonly string[]).includes(kind)) continue;
      const n = m[2] ? Number(m[2]) : 1;
      this.map[token] = value;
      this.byKey.set(`${kind}:${keyOf(kind, value)}`, token);
      this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, n));
    }
  }

  tokenFor(kind: PseudonymKind, original: string): string {
    // Un nom connu à la fois comme client et comme personne garde son premier jeton.
    const lookupKinds: PseudonymKind[] = kind === 'CLIENT' || kind === 'PERSONNE' ? ['CLIENT', 'PERSONNE'] : [kind];
    for (const k of lookupKinds) {
      const existing = this.byKey.get(`${k}:${keyOf(k, original)}`);
      if (existing) return existing;
    }
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    // Le client principal est `[CLIENT]` (sans numéro), comme dans le brief.
    const token = kind === 'CLIENT' && n === 1 ? '[CLIENT]' : `[${kind}_${n}]`;
    this.map[token] = original;
    this.byKey.set(`${kind}:${keyOf(kind, original)}`, token);
    return token;
  }
}

function runPass(text: string, finder: Finder, table: TokenTable): string {
  return splitOnTokens(text)
    .map((part) => {
      if (part.token) return part.value;
      const hits = finder(part.value);
      if (hits.length === 0) return part.value;
      let out = '';
      let cursor = 0;
      for (const h of hits) {
        if (h.start < cursor) continue;
        out += part.value.slice(cursor, h.start) + table.tokenFor(h.kind, part.value.slice(h.start, h.end));
        cursor = h.end;
      }
      return out + part.value.slice(cursor);
    })
    .join('');
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Remplace les données sensibles par des jetons. Déterministe et idempotent :
 * `pseudonymize(r.text, known, { map: r.map })` renvoie `r` à l'identique.
 */
export function pseudonymize(
  text: string,
  known: KnownEntities = {},
  options: PseudonymizeOptions = {},
): PseudonymizationResult {
  const table = new TokenTable(options.map);
  let out = text;
  for (const pass of buildPasses(known)) out = runPass(out, pass, table);
  return { text: out, map: { ...table.map } };
}

export interface ReidentifyOptions {
  /** Échappe les valeurs réinjectées dans du HTML (un nom « A&B » reste du texte). */
  readonly escapeHtml?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Réinjecte les valeurs d'origine. Un jeton inconnu de la table est laissé tel quel. */
export function reidentify(text: string, map: PseudonymizationMap, options: ReidentifyOptions = {}): string {
  return text.replace(TOKEN_RE, (token) => {
    const value = map[token];
    if (value === undefined) return token;
    return options.escapeHtml ? escapeHtml(value) : value;
  });
}

export interface LeakCheckOptions {
  /**
   * Vérifie aussi les motifs détectables (e-mail, IBAN, montants…), pas
   * seulement les entités connues. Vrai par défaut : c'est un garde-fou.
   */
  readonly detectPatterns?: boolean;
}

/** Liste les valeurs sensibles encore présentes (hors jetons). Ne renvoie jamais la valeur. */
export function findLeaks(text: string, known: KnownEntities = {}, options: LeakCheckOptions = {}): LeakReport[] {
  const detectPatterns = options.detectPatterns ?? true;
  const leaks: LeakReport[] = [];
  const seen = new Set<string>();
  for (const part of splitOnTokens(text)) {
    if (part.token) continue;
    for (const pass of buildPasses(known)) {
      for (const h of pass(part.value)) {
        if (h.source === 'pattern' && !detectPatterns) continue;
        const k = `${part.offset + h.start}:${h.kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        leaks.push({ kind: h.kind, source: h.source, offset: part.offset + h.start });
      }
    }
  }
  return leaks.sort((a, b) => a.offset - b.offset);
}

/**
 * Garde-fou d'envoi : lève `PseudonymizationLeakError` si une valeur sensible
 * connue (ou un motif sensible, par défaut) subsiste dans `text`.
 */
export function assertNoLeak(text: string, known: KnownEntities = {}, options: LeakCheckOptions = {}): void {
  const leaks = findLeaks(text, known, options);
  if (leaks.length > 0) throw new PseudonymizationLeakError(leaks);
}
