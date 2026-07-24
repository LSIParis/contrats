import { Injectable } from '@nestjs/common';
import HTMLtoDOCX from '@turbodocx/html-to-docx';
import type { DocxRenderer } from './docx-renderer.port.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * HTML → DOCX via @turbodocx/html-to-docx (pur JS). Le HTML reçu est déjà
 * assaini en amont. On l'enveloppe d'un document minimal (titre + police
 * serif) pour un rendu Word propre.
 */
@Injectable()
export class HtmlToDocxRenderer implements DocxRenderer {
  async renderDocx(html: string, title: string): Promise<Buffer> {
    const doc = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
    const out = await HTMLtoDOCX(doc, null, { title, font: 'Georgia' });
    // La lib peut renvoyer un Buffer, un ArrayBuffer ou un Blob selon l'env.
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof ArrayBuffer) return Buffer.from(out);
    if (typeof (out as Blob).arrayBuffer === 'function') return Buffer.from(await (out as Blob).arrayBuffer());
    return Buffer.from(out as unknown as Uint8Array);
  }
}
