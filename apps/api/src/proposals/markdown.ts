import { sanitizeContractHtml } from '../documents/html-sanitizer.js';

/**
 * Markdown RESTREINT des contenus de proposition (modèles de l'annexe C,
 * bibliothèque, blocs de texte) → HTML assaini.
 *
 * Volontairement minimal : titres (#, ##, ###), paragraphes, listes à puces,
 * tableaux à barres verticales, gras, italique, sauts de ligne. Le texte est
 * ÉCHAPPÉ avant toute mise en forme, et le HTML produit repasse par la liste
 * blanche des contrats (`sanitizeContractHtml`) : aucun script, aucun
 * attribut d'événement, aucun lien en `javascript:` ne peut sortir d'ici.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function markdownToHtml(md: string | null | undefined): string {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`);
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      flushList();
      const level = (h[1] as string).length + 1; // # → h2 : le titre de la page est h1
      out.push(`<h${level}>${inline(h[2] as string)}</h${level}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(trimmed);
    if (li) {
      flushPara();
      list.push(li[1] as string);
      continue;
    }
    if (trimmed.startsWith('|') && TABLE_SEPARATOR.test((lines[i + 1] ?? '').trim())) {
      flushPara();
      flushList();
      const head = cells(trimmed);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).trim().startsWith('|')) {
        body.push(cells(lines[i] as string));
        i++;
      }
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return sanitizeContractHtml(out.join('\n'));
}
