import { Injectable } from '@nestjs/common';
import HTMLtoDOCX from '@turbodocx/html-to-docx';
import type { DocxRenderer } from './docx-renderer.port.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Retire les balises chargeant une ressource DISTANTE (<img>). Défense en
 * profondeur : @turbodocx/html-to-docx va chercher les `<img src>` distants
 * pour les embarquer (deps axios/follow-redirects), ce qui est une surface
 * SSRF côté API. Le bodyHtml est déjà assaini en amont (allowlist du
 * sanitizer SANS `img`), mais on ne dépend PAS de ce couplage : on strippe
 * aussi ici, pour que ce renderer reste sûr même si l'allowlist change.
 */
export function stripRemoteResources(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, '');
}

/**
 * HTML → DOCX via @turbodocx/html-to-docx (pur JS). Le HTML reçu est déjà
 * assaini en amont. On l'enveloppe d'un document minimal (titre + police
 * serif) pour un rendu Word propre.
 */
@Injectable()
export class HtmlToDocxRenderer implements DocxRenderer {
  async renderDocx(html: string, title: string): Promise<Buffer> {
    const safe = stripRemoteResources(html);
    const doc = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${safe}</body></html>`;
    const out = await HTMLtoDOCX(doc, null, { title: escapeHtml(title), font: 'Georgia' });
    // La lib peut renvoyer un Buffer, un ArrayBuffer ou un Blob selon l'env.
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof ArrayBuffer) return Buffer.from(out);
    if (typeof (out as Blob).arrayBuffer === 'function') return Buffer.from(await (out as Blob).arrayBuffer());
    return Buffer.from(out as unknown as Uint8Array);
  }
}
