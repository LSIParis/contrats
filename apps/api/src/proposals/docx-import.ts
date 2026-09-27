import { inflateRawSync } from 'node:zlib';
import type { SectionInput } from './proposal-content.js';

/**
 * Import d'un document Word existant comme point de départ (brief §12.3) :
 * .docx → sections et blocs de texte.
 *
 * Conversion VOLONTAIREMENT simple, sans dépendance : le .docx est une archive
 * ZIP dont on lit `word/document.xml` ; chaque titre de niveau 1 (style
 * Heading1 / Titre1) ouvre une section, les titres 2-3 deviennent des sous-
 * titres, les paragraphes du texte, les paragraphes numérotés ou à puces une
 * liste. Mise en forme fine, images et tableaux complexes ne sont pas repris :
 * le résultat est un BROUILLON que le commercial relit (aucun envoi sans les
 * contrôles de préparation). Taille et nombre d'entrées bornés (archive piégée).
 */

const MAX_XML_BYTES = 20 * 1024 * 1024;

export class DocxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxImportError';
  }
}

/** Lit une entrée d'une archive ZIP (répertoire central, méthodes 0 et 8). */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > zip.length) throw new DocxImportError('Archive .docx illisible (fin de répertoire absente).');
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if (entries > 5000) throw new DocxImportError('Archive .docx anormale (trop d’entrées).');
  for (let i = 0; i < entries; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new DocxImportError('Répertoire central .docx invalide.');
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (size > MAX_XML_BYTES) throw new DocxImportError('Document Word trop volumineux.');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new DocxImportError('Entrée .docx invalide.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
    throw new DocxImportError(`Méthode de compression ${method} non prise en charge.`);
  }
  return null;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

interface Paragraph {
  readonly style: string;
  readonly list: boolean;
  readonly text: string;
}

export function paragraphsOf(documentXml: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const m of documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const list = /<w:numPr>/.test(p) || /List/i.test(style);
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map((t) => (t[1] !== undefined ? decode(t[1]) : t[0] === '<w:tab/>' ? ' ' : '\n'))
      .join('')
      .trim();
    out.push({ style, list, text });
  }
  return out;
}

const headingLevel = (style: string): number => {
  const m = /^(?:Heading|Titre|Title)(\d)?$/i.exec(style);
  if (!m) return 0;
  return m[1] ? Number(m[1]) : 1;
};

const slug = (s: string, i: number) =>
  (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'section'
  ) + `-${i}`;

/** .docx → sections TEXT (une par titre de niveau 1 ; le texte d'avant forme « Introduction »). */
export function docxToSections(docx: Buffer): SectionInput[] {
  const xml = readZipEntry(docx, 'word/document.xml');
  if (!xml) throw new DocxImportError('Ce fichier n’est pas un document Word (.docx).');
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const p of paragraphsOf(xml.toString('utf8'))) {
    if (!p.text) {
      current?.lines.push('');
      continue;
    }
    const level = headingLevel(p.style);
    if (level === 1) {
      current = { title: p.text.slice(0, 200), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: 'Introduction', lines: [] };
      sections.push(current);
    }
    if (level >= 2) current.lines.push('', `${'#'.repeat(Math.min(level, 3))} ${p.text}`, '');
    else if (p.list) current.lines.push(`- ${p.text.replace(/\n/g, ' ')}`);
    else current.lines.push(p.text, '');
  }
  return sections
    .filter((s) => s.title || s.lines.some((l) => l.trim()))
    .slice(0, 30)
    .map((s, i) => ({
      key: slug(s.title, i + 1),
      title: s.title,
      kind: 'TEXT' as const,
      blocks: [{ type: 'RICH_TEXT' as const, content: { markdown: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50_000) } }],
    }));
}
