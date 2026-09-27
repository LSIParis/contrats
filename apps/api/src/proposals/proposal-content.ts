import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MERGE_TAG_CATALOG,
  findMergeTags,
  formatMergeValue,
  renderMergeTags,
  type MergeValues,
} from '@lsi/domain';
import { formatCents, type ProposalQuote, type QuotedLine } from '@lsi/pricing';
import { markdownToHtml } from './markdown.js';

/**
 * Contenu d'une proposition : blocs typés, valeurs de fusion, rendu HTML
 * (page publique, aperçu, PDF), contrôles de préparation et empreinte.
 *
 * Tout le HTML produit ici sort de `markdownToHtml` (texte échappé puis liste
 * blanche) ou de gabarits dont chaque valeur est échappée : la page publique
 * l'affiche tel quel, le rendu PDF (Gotenberg) aussi.
 */

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------

const Markdown = z.string().max(50_000);
const Items = <T extends z.ZodRawShape>(shape: T) => z.array(z.object(shape).strict()).max(50);

export const BLOCK_CONTENT_SCHEMAS = {
  RICH_TEXT: z
    .object({ markdown: Markdown, guidance: z.string().max(5000).optional(), sourceSha256: z.string().length(64).optional() })
    .strict(),
  // Image et vidéo HÉBERGÉES : chemin relatif à l'application ou URL https
  // (affichées en lien si l'origine n'est pas la nôtre — CSP stricte).
  IMAGE: z.object({ url: z.string().regex(/^(\/[^\s]*|https:\/\/[^\s]+)$/).max(2000), alt: z.string().max(300) }).strict(),
  VIDEO: z.object({ url: z.string().regex(/^(\/[^\s]*|https:\/\/[^\s]+)$/).max(2000), title: z.string().max(300) }).strict(),
  PRICING_TABLE: z.object({ intro: Markdown.optional() }).strict(),
  TIMELINE: z.object({ items: Items({ label: z.string().max(300), date: z.string().max(40).optional(), description: z.string().max(2000).optional() }) }).strict(),
  TEAM: z.object({ members: Items({ name: z.string().max(200), role: z.string().max(200) }) }).strict(),
  REFERENCES: z.object({ items: Items({ name: z.string().max(200), description: z.string().max(2000).optional() }) }).strict(),
  FAQ: z.object({ items: Items({ question: z.string().max(500), answer: z.string().max(5000) }) }).strict(),
  TERMS: z.object({}).strict(),
  SIGNATURE: z.object({}).strict(),
} as const;
export type BlockType = keyof typeof BLOCK_CONTENT_SCHEMAS;

export const BlockInputSchema = z
  .object({ type: z.enum(Object.keys(BLOCK_CONTENT_SCHEMAS) as [BlockType, ...BlockType[]]), content: z.unknown() })
  .strict()
  .superRefine((b, ctx) => {
    const r = BLOCK_CONTENT_SCHEMAS[b.type].safeParse(b.content);
    if (!r.success) ctx.addIssue({ code: 'custom', message: `bloc ${b.type} : ${r.error.issues.map((i) => i.message).join(', ')}` });
  });

export const SectionInputSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(64),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['COVER', 'LIBRARY', 'TEXT', 'CLIENT_INPUT', 'PRICING', 'TERMS', 'SIGNATURE']),
    optional: z.boolean().optional(),
    excluded: z.boolean().optional(),
    libraryItemKey: z.string().max(64).nullable().optional(),
    guidance: z.string().max(5000).nullable().optional(),
    blocks: z.array(BlockInputSchema).max(30),
  })
  .strict();
export type SectionInput = z.infer<typeof SectionInputSchema>;

export const SectionsInputSchema = z
  .object({ sections: z.array(SectionInputSchema).min(1).max(40) })
  .strict()
  .superRefine((v, ctx) => {
    const keys = new Set<string>();
    for (const s of v.sections) {
      if (keys.has(s.key)) ctx.addIssue({ code: 'custom', message: `section en double : ${s.key}` });
      keys.add(s.key);
    }
    for (const kind of ['PRICING', 'SIGNATURE'] as const) {
      if (v.sections.filter((s) => s.kind === kind).length !== 1) {
        ctx.addIssue({ code: 'custom', message: `il faut exactement une section ${kind}` });
      }
    }
  });

export interface SectionWithBlocks {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly position: number;
  readonly optional: boolean;
  readonly excluded: boolean;
  readonly validationStatus: string;
  readonly libraryItemKey: string | null;
  readonly guidance: string | null;
  readonly aiPendingReview: boolean;
  readonly blocks: readonly { readonly position: number; readonly type: string; readonly content: unknown }[];
}

// ---------------------------------------------------------------------------
// Valeurs de fusion
// ---------------------------------------------------------------------------

export interface MergeSources {
  readonly customer: { name: string; legalName: string | null; siren: string | null };
  readonly contact: { firstName: string | null; lastName: string | null } | null;
  readonly ownerName: string | null;
  readonly number: string;
  /** « YYYY-MM-DD » (échéance réelle, ou projetée tant que non envoyée). */
  readonly expiryDay: string | null;
  readonly mergeContext: Readonly<Record<string, unknown>>;
  readonly quote: Pick<ProposalQuote, 'oneTime' | 'monthly' | 'commitment' | 'commitmentMonths'> | null;
}

export function mergeValuesFor(s: MergeSources): Record<string, string | number> {
  const out: Record<string, string | number | null | undefined> = {
    'client.raisonSociale': s.customer.legalName ?? s.customer.name,
    'client.siren': s.customer.siren,
    'contact.prenom': s.contact?.firstName,
    'contact.nom': s.contact?.lastName,
    'commercial.nom': s.ownerName,
    'proposition.numero': s.number,
    'proposition.dateExpiration': s.expiryDay,
    'tarif.totalPonctuelHT': s.quote ? Number(s.quote.oneTime.htCents) : null,
    'tarif.totalMensuelHT': s.quote ? Number(s.quote.monthly.htCents) : null,
    'tarif.totalEngagementHT': s.quote ? Number(s.quote.commitment.htCents) : null,
    'engagement.dureeMois': s.quote && s.quote.commitmentMonths > 0 ? s.quote.commitmentMonths : null,
  };
  // Valeurs saisies (parc.*, client.effectif, contact.civilite…) : seulement
  // les balises du catalogue, jamais une clé arbitraire.
  for (const [k, v] of Object.entries(s.mergeContext)) {
    if (Object.hasOwn(MERGE_TAG_CATALOG, k) && (typeof v === 'string' || typeof v === 'number') && out[k] == null) out[k] = v;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined && v !== '')) as Record<string, string | number>;
}

/** Contexte du moteur (quantités par défaut, présélection) : les valeurs numériques du catalogue. */
export function pricingContextOf(mergeContext: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(mergeContext)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Object.hasOwn(MERGE_TAG_CATALOG, k) && Number.isInteger(n)) out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Préparation (gardes « PRÊTE »)
// ---------------------------------------------------------------------------

export interface ReadinessIssue {
  readonly code: 'MERGE_TAG' | 'UNKNOWN_TAG' | 'TO_COMPLETE' | 'MISSING_TERMS' | 'TO_VALIDATE' | 'PRICING' | 'CLICK_ACCEPT_THRESHOLD' | 'AI_PENDING';
  readonly message: string;
  readonly sectionKey?: string;
}

/** Marqueur laissé par la rédaction (consigne des modèles : « laisser [à compléter] »). */
const TO_COMPLETE = /\[à compléter\]/i;

/** Textes d'un bloc visibles par le client (jamais la consigne `guidance`). */
function visibleTexts(type: string, content: unknown): string[] {
  const c = (content ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'RICH_TEXT':
      return [String(c.markdown ?? '')];
    case 'PRICING_TABLE':
      return [String(c.intro ?? '')];
    case 'IMAGE':
      return [String(c.alt ?? '')];
    case 'VIDEO':
      return [String(c.title ?? '')];
    case 'TIMELINE':
    case 'REFERENCES':
    case 'FAQ':
      return ((c.items as Record<string, unknown>[] | undefined) ?? []).flatMap((i) => Object.values(i).map(String));
    case 'TEAM':
      return ((c.members as Record<string, unknown>[] | undefined) ?? []).flatMap((i) => Object.values(i).map(String));
    default:
      return [];
  }
}

export function contentIssues(
  title: string,
  sections: readonly SectionWithBlocks[],
  values: MergeValues,
  hasTerms: boolean,
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const check = (text: string, sectionKey?: string) => {
    for (const tag of new Set(findMergeTags(text))) {
      if (!Object.hasOwn(MERGE_TAG_CATALOG, tag)) {
        issues.push({ code: 'UNKNOWN_TAG', message: `Balise inconnue {{${tag}}}.`, ...(sectionKey ? { sectionKey } : {}) });
      } else if (formatMergeValue(tag, values[tag]) === null) {
        issues.push({ code: 'MERGE_TAG', message: `Balise {{${tag}}} sans valeur.`, ...(sectionKey ? { sectionKey } : {}) });
      }
    }
    if (TO_COMPLETE.test(text)) issues.push({ code: 'TO_COMPLETE', message: 'Texte « [à compléter] » restant.', ...(sectionKey ? { sectionKey } : {}) });
  };
  check(title);
  for (const s of sections) {
    if (s.excluded) continue;
    check(s.title, s.key);
    const texts = s.blocks.flatMap((b) => visibleTexts(b.type, b.content));
    for (const t of texts) check(t, s.key);
    if (s.kind === 'CLIENT_INPUT' && !texts.some((t) => t.trim())) {
      issues.push({ code: 'TO_COMPLETE', message: `Section « ${s.title} » à compléter.`, sectionKey: s.key });
    }
    if (s.kind === 'TERMS' && !hasTerms) {
      issues.push({ code: 'MISSING_TERMS', message: 'Aucune version des CGV n’est publiée : elles doivent être jointes.', sectionKey: s.key });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const merged = (text: string, values: MergeValues) => renderMergeTags(text, values).text;

function blockHtml(type: string, content: unknown, values: MergeValues): string {
  const c = (content ?? {}) as Record<string, any>;
  switch (type) {
    case 'RICH_TEXT':
      return markdownToHtml(merged(String(c.markdown ?? ''), values));
    case 'PRICING_TABLE':
      return c.intro ? markdownToHtml(merged(String(c.intro), values)) : '';
    case 'IMAGE':
      return String(c.url).startsWith('/')
        ? `<figure><img src="${esc(String(c.url))}" alt="${esc(String(c.alt ?? ''))}"></figure>`
        : `<p><a href="${esc(String(c.url))}" rel="noopener noreferrer">${esc(String(c.alt || 'Image'))}</a></p>`;
    case 'VIDEO':
      return `<p><a href="${esc(String(c.url))}" rel="noopener noreferrer">${esc(String(c.title || 'Vidéo'))}</a></p>`;
    case 'TIMELINE':
      return `<ul>${((c.items ?? []) as any[]).map((i) => `<li><strong>${esc(merged(i.label, values))}</strong>${i.date ? ` — ${esc(i.date)}` : ''}${i.description ? `<br>${esc(merged(i.description, values))}` : ''}</li>`).join('')}</ul>`;
    case 'TEAM':
      return `<ul>${((c.members ?? []) as any[]).map((m) => `<li><strong>${esc(m.name)}</strong> — ${esc(m.role)}</li>`).join('')}</ul>`;
    case 'REFERENCES':
      return `<ul>${((c.items ?? []) as any[]).map((i) => `<li><strong>${esc(i.name)}</strong>${i.description ? ` — ${esc(merged(i.description, values))}` : ''}</li>`).join('')}</ul>`;
    case 'FAQ':
      return ((c.items ?? []) as any[]).map((i) => `<h4>${esc(merged(i.question, values))}</h4>${markdownToHtml(merged(i.answer, values))}`).join('');
    default:
      return '';
  }
}

export interface RenderedSection {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly html: string;
  readonly aiPendingReview: boolean;
}

export function renderSections(
  sections: readonly SectionWithBlocks[],
  values: MergeValues,
  terms: { title: string; body: string } | null,
): RenderedSection[] {
  return [...sections]
    .filter((s) => !s.excluded)
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      let html = [...s.blocks].sort((a, b) => a.position - b.position).map((b) => blockHtml(b.type, b.content, values)).join('\n');
      if (s.kind === 'TERMS' && terms) html += `<h3>${esc(terms.title)}</h3>${markdownToHtml(terms.body)}`;
      return { key: s.key, title: merged(s.title, values), kind: s.kind, html, aiPendingReview: s.aiPendingReview };
    });
}

const euros = (cents: bigint) => `${formatCents(cents).replace('.', ',')} €`;

/** Tableau de prix (HTML) : lignes retenues, tarifs affichés, totaux séparés HT / TVA / TTC. */
export function pricingTableHtml(quote: ProposalQuote): string {
  const row = (l: QuotedLine) =>
    `<tr><td>${esc(l.label)}</td><td>${l.recurrence === 'DISCOUNT' || l.recurrence === 'MINIMUM' ? '' : esc(String(l.quantity))}</td>` +
    `<td>${esc(l.unit)}</td><td>${l.priceFrom ? 'à partir de ' : ''}${euros(l.unitPriceCents)}</td><td>${euros(l.totalHtCents)}</td></tr>`;
  const bucket = (label: string, b: { htCents: bigint; vatCents: bigint; ttcCents: bigint }) =>
    b.htCents === 0n ? '' : `<tr><th>${esc(label)}</th><td>${euros(b.htCents)} HT</td><td>${euros(b.vatCents)} TVA</td><td>${euros(b.ttcCents)} TTC</td></tr>`;
  return (
    `<table><thead><tr><th>Prestation</th><th>Qté</th><th>Unité</th><th>Prix unitaire HT</th><th>Total HT</th></tr></thead>` +
    `<tbody>${quote.lines.map(row).join('')}</tbody></table>` +
    `<table><tbody>${bucket('Ponctuel', quote.oneTime)}${bucket('Mensuel récurrent', quote.monthly)}` +
    `${bucket('Trimestriel', quote.quarterly)}${bucket('Prestations annuelles', quote.yearly)}` +
    `${bucket(`Total sur ${quote.commitmentMonths} mois`, quote.commitment)}</tbody></table>` +
    (quote.infoLines.length
      ? `<p><strong>Tarifs hors forfait :</strong> ${quote.infoLines.map((l) => `${esc(l.label)} — ${euros(l.unitPriceCents)} HT / ${esc(l.unit)}`).join(' ; ')}</p>`
      : '')
  );
}

/** Document HTML complet (aperçu, PDF de version, PDF de signature). */
export function proposalHtmlDocument(p: {
  number: string;
  title: string;
  sections: readonly RenderedSection[];
  pricingHtml: string;
  signatureHtml?: string;
}): string {
  const body = p.sections
    .map((s) => {
      const extra = s.kind === 'PRICING' ? p.pricingHtml : s.kind === 'SIGNATURE' ? (p.signatureHtml ?? '') : '';
      return `<section><h2>${esc(s.title)}</h2>${s.html}${extra}</section>`;
    })
    .join('\n');
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(p.number)}</title>` +
    `<style>body{font-family:sans-serif;font-size:10.5pt;color:#14191c}h1,h2{color:#1C3B3F}` +
    `table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d6e4e5;padding:4px 6px;text-align:left}</style>` +
    `</head><body><h1>${esc(p.title)}</h1><p>Proposition n° ${esc(p.number)}</p>${body}</body></html>`
  );
}

// ---------------------------------------------------------------------------
// Empreinte
// ---------------------------------------------------------------------------

/** JSON à clés triées : base des empreintes (indépendante de l'ordre des clés). */
export function stableStringify(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
