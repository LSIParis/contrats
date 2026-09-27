/**
 * Extraction LOCALE des métadonnées d'un contrat importé (brief §3, étape 4).
 *
 * Entrée : le texte OCR (ocrmypdf + Tesseract `fra`) d'un contrat signé hors
 * plateforme. Sortie : des PROPOSITIONS de valeurs, chacune avec un score de
 * confiance et la preuve textuelle qui la justifie — jamais une vérité. Aucun
 * contrat importé ne devient ACTIF sans validation humaine champ par champ
 * (écran côte à côte) ; la confiance sert à attirer l'œil sur les champs
 * douteux, pas à sauter la validation.
 *
 * Choix délibérés :
 *
 * - Règles et expressions régulières, AUCUN appel réseau : le texte d'un
 *   contrat signé est une donnée client. L'extraction par LLM (optionnelle,
 *   derrière `contrats.ai.enabled`) ne recevrait que du texte pseudonymisé.
 * - `null` plutôt qu'une devinette : un champ vide attire l'attention du
 *   valideur, une valeur fausse à 40 % de confiance se fait valider par
 *   lassitude.
 * - La preuve (`evidence`) est un extrait EXACT du texte source avec son
 *   décalage : l'écran de validation peut le surligner sans recalcul.
 * - Fonction PURE : même texte → même résultat, testable sur des fixtures.
 */

import {
  EURO_AMOUNT_RE,
  QUANTITY,
  findDates,
  foldSameLength,
  parseEuroCents,
  parseQuantity,
  repairOcr,
  type FoundDate,
} from './french-parsing.js';

export interface ExtractionEvidence {
  /** Extrait exact du texte source. */
  readonly excerpt: string;
  /** Position (en unités UTF-16) de l'extrait dans le texte source. */
  readonly offset: number;
}

export interface ExtractedField<T> {
  readonly value: T;
  /** 0..1 — indicatif, sert à ordonner la revue humaine. */
  readonly confidence: number;
  readonly evidence: ExtractionEvidence;
}

export type MaybeExtractedField<T> = ExtractedField<T> | null;

export type ExtractedReconduction = 'TACITE' | 'EXPRESSE' | 'AUCUNE';

export const REVISION_INDICES = ['SYNTEC', 'ICHT', 'IPC', 'BT01', 'ILAT', 'ILC', 'PSDC'] as const;
export type RevisionIndex = (typeof REVISION_INDICES)[number];

export interface ExtractedNotice {
  readonly quantite: number;
  readonly unite: 'JOURS' | 'MOIS';
}

export interface ExtractedContractMetadata {
  readonly prestataireRaisonSociale: MaybeExtractedField<string>;
  readonly prestataireSiren: MaybeExtractedField<string>;
  readonly clientRaisonSociale: MaybeExtractedField<string>;
  readonly clientSiren: MaybeExtractedField<string>;
  /** Date ISO `YYYY-MM-DD`. */
  readonly dateSignature: MaybeExtractedField<string>;
  /** Date ISO `YYYY-MM-DD`. */
  readonly dateEffet: MaybeExtractedField<string>;
  readonly dureeMois: MaybeExtractedField<number>;
  readonly reconduction: MaybeExtractedField<ExtractedReconduction>;
  readonly preavis: MaybeExtractedField<ExtractedNotice>;
  /** Montant mensuel HORS TAXES, en centimes d'euro. */
  readonly montantMensuelHtCentimes: MaybeExtractedField<number>;
  /** Montant annuel HORS TAXES, en centimes d'euro. */
  readonly montantAnnuelHtCentimes: MaybeExtractedField<number>;
  readonly indiceRevision: MaybeExtractedField<RevisionIndex>;
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

interface Ctx {
  /** Texte source, tel que reçu. */
  readonly source: string;
  /** Texte réparé + replié (minuscules sans accents), MÊME LONGUEUR que `source`. */
  readonly folded: string;
  readonly dates: readonly FoundDate[];
}

function field<T>(ctx: Ctx, value: T, confidence: number, start: number, end: number): ExtractedField<T> {
  const s = Math.max(0, start);
  const e = Math.min(ctx.source.length, Math.max(end, s));
  return {
    value,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    evidence: { excerpt: ctx.source.slice(s, e), offset: s },
  };
}

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

/** Contrôle de Luhn d'un SIREN : un échec baisse la confiance (souvent une erreur d'OCR). */
export function isValidSiren(siren: string): boolean {
  if (!/^\d{9}$/.test(siren)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(siren[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function best<T>(candidates: readonly (ExtractedField<T> | null)[]): MaybeExtractedField<T> {
  let winner: ExtractedField<T> | null = null;
  for (const c of candidates) if (c && (!winner || c.confidence > winner.confidence)) winner = c;
  return winner;
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const PRESTATAIRE_ROLES = ['prestataire', 'fournisseur', 'titulaire', 'mainteneur', 'infogerant'];
const CLIENT_ROLES = ['client', 'beneficiaire', 'souscripteur', "donneur d'ordre"];

const ROLE_MARKER_RE = new RegExp(
  `ci[\\s-]*apres\\s*,?\\s*(?:(?:denomme|designe|appele|nomme)e?s?\\s+)?(?:[«"“]\\s*)?(?:la\\s+societe\\s+|l'|le\\s+|la\\s+)?(${[...PRESTATAIRE_ROLES, ...CLIENT_ROLES].join('|')})(?![a-z])`,
  'g',
);

const PARTY_BOUNDARY_RE =
  /entre\s+les\s+(?:soussignes|parties)\s*:?|(?:^|\n)\s*entre\s*:?|d'une\s+part\s*[,;.]?|d'autre\s+part\s*[,;.]?|(?:^|\n)\s*et\s*:?[ \t]*(?=\n|la\s+societe|l'|le\s|la\s)|(?:^|\n)\s*(?:article|preambule|il\s+a\s+ete)/g;

const SIREN_IN_BLOCK_RE =
  /(siren|siret|rcs|registre\s+du\s+commerce|immatricul[a-z]*|numero\s+unique)[\s\S]{0,60}?(\d{3}\s?\d{3}\s?\d{3}(?:\s?\d{5})?)(?!\s?\d)/;

interface Party {
  readonly name: MaybeExtractedField<string>;
  readonly siren: MaybeExtractedField<string>;
}

function extractPartyBlock(ctx: Ctx, blockStart: number, blockEnd: number): Party {
  const blockFolded = ctx.folded.slice(blockStart, blockEnd);
  const blockSource = ctx.source.slice(blockStart, blockEnd);

  // Raison sociale : après « la société », sinon la première ligne non vide.
  let name: MaybeExtractedField<string> = null;
  // « la société X » (et non « Société par actions simplifiée », qui est une forme juridique).
  const soc = /la\s+societe\s*:?\s+/.exec(blockFolded);
  const nameFrom = (start: number, confidence: number): MaybeExtractedField<string> => {
    const rest = blockSource.slice(start);
    const cut = /[,\n(]|\s+(?:au\s+capital|dont\s+le\s+siege|sise|immatricul|represent|ci-?\s?apr)/i.exec(rest);
    const raw = (cut ? rest.slice(0, cut.index) : rest.slice(0, 80))
      .replace(/[«»"“”:]/g, '')
      .replace(/^\s*(?:l['’]\s*(?:association|entreprise|[ée]tablissement)|la\s+soci[ée]t[ée]|la\s+commune\s+de|le\s+groupement)\s+/i, '')
      .trim();
    if (raw.length < 2 || raw.length > 120) return null;
    const lead = rest.indexOf(raw);
    return field(ctx, raw.replace(/\s+/g, ' '), confidence, blockStart + start + lead, blockStart + start + lead + raw.length);
  };
  if (soc) name = nameFrom(soc.index + soc[0].length, 0.85);
  if (!name) {
    const firstLine = /[^\s:]/.exec(blockSource);
    if (firstLine) name = nameFrom(firstLine.index, 0.55);
  }

  let siren: MaybeExtractedField<string> = null;
  const sm = SIREN_IN_BLOCK_RE.exec(blockFolded);
  if (sm && sm[2]) {
    const digits = sm[2].replace(/\s/g, '');
    const value = digits.slice(0, 9);
    const numberStart = sm.index + sm[0].length - sm[2].length;
    let confidence = isValidSiren(value) ? 0.9 : 0.65;
    if (digits.length === 14) confidence -= 0.05; // SIREN déduit d'un SIRET
    siren = field(ctx, value, confidence, blockStart + sm.index, blockStart + numberStart + sm[2].length);
  }
  return { name, siren };
}

function extractParties(ctx: Ctx): { prestataire: Party; client: Party } {
  const empty: Party = { name: null, siren: null };
  const result = { prestataire: empty, client: empty };
  const boundaries = allMatches(PARTY_BOUNDARY_RE, ctx.folded).map((m) => m.index + m[0].length);
  // Les parties sont présentées en tête : on ne regarde que le premier tiers (min. 4000 caractères).
  const horizon = Math.max(4000, Math.floor(ctx.folded.length / 3));
  for (const m of allMatches(ROLE_MARKER_RE, ctx.folded.slice(0, horizon))) {
    const role = m[1] as string;
    const isPrestataire = PRESTATAIRE_ROLES.includes(role);
    const key = isPrestataire ? 'prestataire' : 'client';
    if (result[key] !== empty) continue;
    const lastBoundary = boundaries.filter((b) => b <= m.index).pop() ?? 0;
    const blockStart = Math.max(lastBoundary, m.index - 700);
    result[key] = extractPartyBlock(ctx, blockStart, m.index);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

interface Anchor {
  readonly re: RegExp;
  readonly confidence: number;
}

const SIGNATURE_ANCHORS: readonly Anchor[] = [
  // « le » borné : sinon « Fait à Lille » s'arrête sur le « le » de « Lille ».
  { re: /fait\s+a\s+[a-z' -]{1,40}?\s*,?\s*(?<![a-z])le(?![a-z])\s*/g, confidence: 0.9 },
  { re: /date\s+de\s+signature\s*:?\s*(?:le\s*)?/g, confidence: 0.9 },
  { re: /fait\s+(?:en\s+\w+\s+exemplaires\s*,?\s*)?le\s*/g, confidence: 0.85 },
  { re: /signe\s+(?:electroniquement\s+)?le\s*/g, confidence: 0.8 },
  { re: /en\s+date\s+du\s*/g, confidence: 0.65 },
];

const EFFECT_ANCHORS: readonly Anchor[] = [
  { re: /date\s+d'effet\s*:?\s*(?:le\s*|au\s*)?/g, confidence: 0.9 },
  { re: /pren(?:d|dra)\s+effet\s+(?:le|au|a\s+compter\s+du|a\s+partir\s+du)\s*/g, confidence: 0.9 },
  { re: /entre(?:ra)?\s+en\s+vigueur\s+(?:le|au|a\s+compter\s+du|a\s+partir\s+du)\s*/g, confidence: 0.9 },
  { re: /(?:a\s+compter\s+du|a\s+partir\s+du)\s*/g, confidence: 0.65 },
];

/** Date qui suit immédiatement une ancre (≤ 3 caractères d'écart). */
function anchoredDates(ctx: Ctx, anchors: readonly Anchor[]): ExtractedField<string>[] {
  const out: ExtractedField<string>[] = [];
  for (const a of anchors) {
    for (const m of allMatches(a.re, ctx.folded)) {
      const end = m.index + m[0].length;
      const d = ctx.dates.find((x) => x.index >= end && x.index <= end + 3);
      if (d) out.push(field(ctx, d.iso, a.confidence, m.index, d.index + d.length));
    }
  }
  return out;
}

function extractSignatureDate(ctx: Ctx): MaybeExtractedField<string> {
  const c = anchoredDates(ctx, SIGNATURE_ANCHORS);
  if (c.length === 0) return null;
  // À confiance égale, la DERNIÈRE occurrence : le bloc de signature est en fin d'acte.
  const top = Math.max(...c.map((x) => x.confidence));
  const last = c.filter((x) => x.confidence === top).sort((a, b) => a.evidence.offset - b.evidence.offset).pop();
  return last ?? null;
}

function extractEffectDate(ctx: Ctx, signature: MaybeExtractedField<string>): MaybeExtractedField<string> {
  const c = anchoredDates(ctx, EFFECT_ANCHORS);
  if (c.length > 0) return best(c.sort((a, b) => a.evidence.offset - b.evidence.offset));
  // « prend effet à la date de sa signature » : on reprend la date de signature, confiance moindre.
  const m = /(?:pren(?:d|dra)\s+effet|entre(?:ra)?\s+en\s+vigueur)\s+(?:a\s+(?:compter\s+de\s+)?)?(?:la\s+date\s+de\s+)?(?:sa\s+|la\s+)?signature/.exec(ctx.folded);
  if (m && signature) return field(ctx, signature.value, Math.min(0.7, signature.confidence), m.index, m.index + m[0].length);
  return null;
}

// ---------------------------------------------------------------------------
// Durée, reconduction, préavis
// ---------------------------------------------------------------------------

const UNIT = '(mois|ans?|annees?)';

function extractDuration(ctx: Ctx): MaybeExtractedField<number> {
  const patterns: Anchor[] = [
    { re: new RegExp(`(?:pour\\s+une|d'une|sa|la)\\s+duree\\s+(?:initiale\\s+|ferme\\s+|irrevocable\\s+|determinee\\s+)*(?:de\\s+|d'\\s*)${QUANTITY}\\s+${UNIT}(?![a-z])`, 'g'), confidence: 0.9 },
    { re: new RegExp(`duree\\s*(?:du\\s+contrat)?\\s*:\\s*${QUANTITY}\\s+${UNIT}(?![a-z])`, 'g'), confidence: 0.85 },
    { re: new RegExp(`conclue?s?\\s+pour\\s+${QUANTITY}\\s+${UNIT}(?![a-z])`, 'g'), confidence: 0.85 },
  ];
  const c: ExtractedField<number>[] = [];
  for (const p of patterns) {
    for (const m of allMatches(p.re, ctx.folded)) {
      const qty = parseQuantity(m[1], m[2]);
      const unit = m[3] ?? '';
      if (!qty) continue;
      const months = unit.startsWith('mois') ? qty : qty * 12;
      if (months < 1 || months > 240) continue;
      c.push(field(ctx, months, p.confidence, m.index, m.index + m[0].length));
    }
  }
  return best(c);
}

const RECONDUCTION_PATTERNS: readonly { kind: ExtractedReconduction; re: RegExp; confidence: number }[] = [
  {
    kind: 'AUCUNE',
    re: /ne\s+(?:sera|pourra)\s+(?:pas|en\s+aucun\s+cas)\s+(?:etre\s+)?(?:tacitement\s+)?(?:renouvele|reconduit|proroge)|sans\s+(?:tacite\s+)?reconduction|exclu(?:t|ant)\s+toute\s+(?:tacite\s+)?reconduction|pas\s+de\s+(?:tacite\s+)?reconduction|non\s+(?:renouvelable|reconductible)|prendra\s+fin\s+de\s+plein\s+droit\s+(?:a|au)\s+(?:son\s+)?(?:terme|echeance)/g,
    confidence: 0.85,
  },
  {
    kind: 'TACITE',
    re: /tacite(?:ment)?\s+reconduction|reconduction\s+tacite|reconduit\s+tacitement|renouvel[a-z]*\s+tacitement|tacitement\s+(?:reconduit|renouvel[a-z]*)/g,
    confidence: 0.9,
  },
  {
    kind: 'EXPRESSE',
    re: /reconduction\s+expresse|renouvellement\s+expres|renouvel[a-z]*\s+(?:(?:par|d'un)\s+)?(?:accord|avenant)\s+expres|renouvel[a-z]*\s+expressement|(?:accord|avenant)\s+expres\s+(?:et\s+ecrit\s+)?des\s+parties/g,
    confidence: 0.85,
  },
];

function extractReconduction(ctx: Ctx): MaybeExtractedField<ExtractedReconduction> {
  const hits: { kind: ExtractedReconduction; start: number; end: number; confidence: number }[] = [];
  for (const p of RECONDUCTION_PATTERNS) {
    for (const m of allMatches(p.re, ctx.folded)) hits.push({ kind: p.kind, start: m.index, end: m.index + m[0].length, confidence: p.confidence });
  }
  // « sans tacite reconduction » contient « tacite reconduction » : une négation englobe.
  const negations = hits.filter((h) => h.kind === 'AUCUNE');
  const kept = hits.filter((h) => h.kind === 'AUCUNE' || !negations.some((n) => h.start >= n.start && h.end <= n.end));
  if (kept.length === 0) return null;
  const kinds = new Set(kept.map((h) => h.kind));
  const top = kept.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  // Indices contradictoires dans l'acte : on propose, mais on signale par la confiance.
  const confidence = kinds.size > 1 ? top.confidence * 0.6 : top.confidence;
  return field(ctx, top.kind, confidence, top.start, top.end);
}

function extractNotice(ctx: Ctx): MaybeExtractedField<ExtractedNotice> {
  const patterns: Anchor[] = [
    // « préav1s » : l'OCR confond i et 1 dans les mots aussi.
    { re: new RegExp(`pre?av[i1l|]s\\s+(?:minimum\\s+|minimal\\s+|ecrit\\s+)?(?:d'au\\s+moins\\s+|de\\s+|d'\\s*)${QUANTITY}\\s+(jours?|mois)(?![a-z])`, 'g'), confidence: 0.9 },
    { re: new RegExp(`(?:au\\s+moins|au\\s+plus\\s+tard|minimum)\\s+${QUANTITY}\\s+(jours?|mois)(?![a-z])\\s+(?:calendaires\\s+)?avant`, 'g'), confidence: 0.7 },
  ];
  const c: ExtractedField<ExtractedNotice>[] = [];
  for (const p of patterns) {
    for (const m of allMatches(p.re, ctx.folded)) {
      const qty = parseQuantity(m[1], m[2]);
      if (!qty || qty > 400) continue;
      const unite = (m[3] ?? '').startsWith('mois') ? 'MOIS' : 'JOURS';
      c.push(field(ctx, { quantite: qty, unite }, p.confidence, m.index, m.index + m[0].length));
    }
  }
  return best(c);
}

// ---------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------

// « mensue11e » : l'OCR lit souvent « ll » comme « 11 ».
const MONTHLY_RE = /mensue[l1]|mensualite|par\s+mois|\/\s*mois|chaque\s+mois/g;
const YEARLY_RE = /annue[l1]|par\s+an(?![a-z])|\/\s*an(?![a-z])|par\s+annee|chaque\s+annee|l'annee/g;

/**
 * Distance (en caractères) entre le montant et la mention de périodicité la
 * plus proche, avant ou après ; `null` si aucune dans la fenêtre.
 */
function periodDistance(re: RegExp, before: string, after: string): number | null {
  let bestDist: number | null = null;
  for (const m of allMatches(re, before)) {
    const d = before.length - (m.index + m[0].length);
    if (bestDist === null || d < bestDist) bestDist = d;
  }
  const a = allMatches(re, after)[0];
  if (a && (bestDist === null || a.index < bestDist)) bestDist = a.index;
  return bestDist;
}

function extractAmounts(ctx: Ctx): { monthly: MaybeExtractedField<number>; yearly: MaybeExtractedField<number> } {
  const monthly: ExtractedField<number>[] = [];
  const yearly: ExtractedField<number>[] = [];
  for (const m of allMatches(EURO_AMOUNT_RE, ctx.folded)) {
    const start = m.index;
    const end = m.index + m[0].length;
    const before = ctx.folded.slice(Math.max(0, start - 140), start);
    const after = ctx.folded.slice(end, end + 30);
    // Le capital social n'est pas un prix ; les pénalités non plus.
    if (/capital|penalit|indemnite\s+forfaitaire/.test(before.slice(-60))) continue;
    if (/^\s*(?:ttc|t\.t\.c|toutes\s+taxes)/.test(after)) continue;
    const htMatch = /^[^€\d]{0,25}?(?:(?<![a-z])ht(?![a-z])|h\.t\.?|hors\s+tax)/.exec(after);
    const ht = htMatch !== null || /hors\s+tax|\(ht\)|(?<![a-z])ht\s*:?\s*$/.test(before.slice(-40));
    const cents = parseEuroCents(m[1] ?? '');
    if (cents === null || cents === 0) continue;
    const md = periodDistance(MONTHLY_RE, before, after);
    const yd = periodDistance(YEARLY_RE, before, after);
    // « 180 € par mois, soit 2 160 € par an » : chaque montant prend la mention la plus proche.
    const pick = md !== null && (yd === null || md <= yd) ? 'm' : yd !== null ? 'y' : null;
    if (!pick) continue;
    const dist = (pick === 'm' ? md : yd) as number;
    const base = dist <= 60 ? 0.9 : 0.75;
    const confidence = ht ? base : base - 0.3;
    const f = field(ctx, cents, confidence, start, end + (htMatch && htMatch[0].length <= 6 ? htMatch[0].length : 0));
    (pick === 'm' ? monthly : yearly).push(f);
  }
  return { monthly: best(monthly), yearly: best(yearly) };
}

// ---------------------------------------------------------------------------
// Indice de révision
// ---------------------------------------------------------------------------

const INDEX_PATTERNS: readonly { value: RevisionIndex; re: RegExp; confidence: number }[] = [
  { value: 'SYNTEC', re: /(?<![a-z])syntec(?![a-z])/g, confidence: 0.9 },
  // OCR dégradé : « Syntcc », « S y n t e c », « Synthec ».
  { value: 'SYNTEC', re: /(?<![a-z])s\s?y\s?n\s?t\s?h?\s?[ec]\s?[ce](?![a-z])/g, confidence: 0.6 },
  { value: 'ICHT', re: /(?<![a-z])icht(?:[\s-]?(?:e|rev[\s-]?ts|ts))?(?![a-z])/g, confidence: 0.85 },
  { value: 'IPC', re: /indice\s+des\s+prix\s+a\s+la\s+consommation|(?<![a-z])ipc(?![a-z])/g, confidence: 0.8 },
  { value: 'BT01', re: /(?<![a-z])bt\s?0?1(?![0-9a-z])/g, confidence: 0.8 },
  { value: 'ILAT', re: /(?<![a-z])ilat(?![a-z])|indice\s+des\s+loyers\s+des\s+activites\s+tertiaires/g, confidence: 0.8 },
  { value: 'ILC', re: /(?<![a-z])ilc(?![a-z])|indice\s+des\s+loyers\s+commerciaux/g, confidence: 0.8 },
  { value: 'PSDC', re: /(?<![a-z])psdc(?![a-z])/g, confidence: 0.75 },
];

function extractIndex(ctx: Ctx): MaybeExtractedField<RevisionIndex> {
  const c: ExtractedField<RevisionIndex>[] = [];
  for (const p of INDEX_PATTERNS) {
    for (const m of allMatches(p.re, ctx.folded)) {
      const before = ctx.folded.slice(Math.max(0, m.index - 80), m.index);
      const bonus = /indice|revision|indexation|revise/.test(before) ? 0.05 : -0.1;
      c.push(field(ctx, p.value, p.confidence + bonus, m.index, m.index + m[0].length));
    }
  }
  return best(c);
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export function extractContractMetadata(text: string): ExtractedContractMetadata {
  const folded = foldSameLength(repairOcr(text));
  const ctx: Ctx = { source: text, folded, dates: findDates(folded) };
  const parties = extractParties(ctx);
  const dateSignature = extractSignatureDate(ctx);
  const amounts = extractAmounts(ctx);
  return {
    prestataireRaisonSociale: parties.prestataire.name,
    prestataireSiren: parties.prestataire.siren,
    clientRaisonSociale: parties.client.name,
    clientSiren: parties.client.siren,
    dateSignature,
    dateEffet: extractEffectDate(ctx, dateSignature),
    dureeMois: extractDuration(ctx),
    reconduction: extractReconduction(ctx),
    preavis: extractNotice(ctx),
    montantMensuelHtCentimes: amounts.monthly,
    montantAnnuelHtCentimes: amounts.yearly,
    indiceRevision: extractIndex(ctx),
  };
}
