import { escapeHtml } from './variables.js';

/**
 * Composition du document d'un contrat structuré (brief §4) : en-tête,
 * articles NUMÉROTÉS, annexes chacune sur une nouvelle page.
 *
 * Le résultat devient `contract_versions.body_html` : c'est CE texte qui est
 * prévisualisé, exporté, rendu en PDF figé (empreinte SHA-256) et signé. Le
 * bloc de signature (balises DocuSeal) et le pied de page sont ajoutés au
 * moment de l'envoi en signature.
 *
 * Les corps de clauses et d'annexes sont supposés DÉJÀ assainis (liste
 * blanche) et leurs variables substituées ; seuls les titres, saisis en texte
 * brut, sont échappés ici.
 */
export interface ComposeInput {
  readonly title: string;
  readonly reference: string;
  /** Bloc « Entre les soussignés » déjà rendu (facultatif). */
  readonly partiesHtml?: string;
  readonly clauses: readonly { title: string; bodyHtml: string }[];
  readonly annexes: readonly { title: string; html: string }[];
}

export function composeContractBody(i: ComposeInput): string {
  const header =
    `<h1 style="text-align:center;">${escapeHtml(i.title)}</h1>` +
    `<p style="text-align:center;color:#555;">Référence ${escapeHtml(i.reference)}</p>`;
  const parties = i.partiesHtml ? `<section class="parties">${i.partiesHtml}</section>` : '';
  const articles = i.clauses
    .map(
      (c, n) =>
        `<section class="article"><h2>Article ${n + 1} — ${escapeHtml(c.title)}</h2>${c.bodyHtml}</section>`,
    )
    .join('\n');
  const annexes = i.annexes
    .map(
      (a, n) =>
        `<section class="annexe" style="page-break-before:always;"><h2>Annexe ${n + 1} — ${escapeHtml(a.title)}</h2>${a.html}</section>`,
    )
    .join('\n');
  return [header, parties, articles, annexes].filter(Boolean).join('\n');
}

/**
 * Pied de page répété (Gotenberg/Chromium) : référence et « page X / Y ».
 * `extraHtml` : paraphes DocuSeal éventuels (text-tags.ts). Document autonome :
 * styles EN LIGNE, taille de police explicite.
 */
export function documentFooterHtml(reference: string, extraHtml = ''): string {
  return (
    `<div style="width:100%;font-size:7pt;font-family:sans-serif;color:#666666;padding:0 1.5cm;display:flex;justify-content:space-between;">` +
    `<span>${escapeHtml(reference)}</span>` +
    `<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
    `</div>${extraHtml}`
  );
}
