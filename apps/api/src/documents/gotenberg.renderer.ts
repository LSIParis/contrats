import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { DocumentRenderer, RenderRequest, RenderedDocument } from '@lsi/domain';

/**
 * Rendu PDF via Gotenberg (Chromium en conteneur). (§9.2)
 *
 * Pourquoi Gotenberg plutôt que Puppeteer intégré : un moteur de rendu est
 * une surface d'attaque. Le corps des contrats est du HTML — assaini, mais
 * du HTML. On met Chromium dans sa propre boîte, sans réseau, plutôt que
 * dans le process qui détient les identifiants de la base.
 *
 * ⚠ NON TESTÉ. Les tests d'envoi utilisent un FakeRenderer : les tester
 * contre Gotenberg mesurerait Chromium, pas notre logique. Cet adaptateur
 * exige un test d'intégration contre le vrai conteneur — ticket W-07.
 * Je préfère le dire que le laisser croire.
 */
@Injectable()
export class GotenbergRenderer implements DocumentRenderer {
  private get url(): string {
    return process.env.GOTENBERG_URL ?? 'http://gotenberg:3000';
  }

  async render(req: RenderRequest): Promise<RenderedDocument> {
    const form = new FormData();
    form.append('files', new Blob([this.wrap(req)], { type: 'text/html' }), 'index.html');

    // PDF/A-2b : format d'archivage normalisé, polices embarquées, aucun
    // contenu externe. Un contrat qui ne s'affiche plus dans 8 ans n'est
    // pas une preuve (§11.2).
    form.append('pdfa', 'PDF/A-2b');
    form.append('pdfua', 'true');
    form.append('marginTop', '0.8');
    form.append('marginBottom', '0.8');

    const res = await fetch(`${this.url}/forms/chromium/convert/html`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`Gotenberg a répondu ${res.status} : ${await res.text().catch(() => '')}`);
    }

    const pdf = Buffer.from(await res.arrayBuffer());
    return { pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
  }

  private wrap(req: RenderRequest): string {
    // Le corps est déjà assaini en amont (§13.3). Gotenberg tourne SANS
    // réseau : une balise <script> ou une image externe qui aurait survécu
    // ne peut ni exfiltrer, ni charger quoi que ce soit.
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${escapeHtml(req.documentTitle)}</title>
<style>
  body { font-family: "Liberation Serif", Georgia, serif; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 16pt; } h2 { font-size: 13pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #666; padding: 4px 6px; }
</style></head>
<body>${req.html}</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
