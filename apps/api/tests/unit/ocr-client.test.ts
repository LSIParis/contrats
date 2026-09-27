import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpOcrClient, OcrError } from '../../src/imports/ocr.client.js';

/** Fixtures capturées : test/fixtures/ocr/ (racine du dépôt). Aucun appel réseau. */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/ocr/${name}`, import.meta.url)), 'utf8');

function stub(status: number, body: string): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('client OCR', () => {
  test('succès : texte, pages et PDF recherchable décodé', async () => {
    const s = stub(200, fixture('ocr-response.success.json'));
    const r = await new HttpOcrClient('http://ocr:8080/', 1000, s.fetch).ocr(Buffer.from('%PDF-1.4'));
    expect(r.pages).toBe(3);
    expect(r.text).toContain('CONTRAT D');
    expect(r.searchablePdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(s.calls[0]!.url).toBe('http://ocr:8080/ocr');
    expect((s.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/pdf');
  });

  test('document refusé (415) : erreur définitive, pas de nouvelle tentative', async () => {
    const s = stub(415, fixture('ocr-response.415.json'));
    const err = await new HttpOcrClient('http://ocr:8080', 1000, s.fetch).ocr(Buffer.from('x')).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err).toMatchObject({ code: 'not_a_pdf', retryable: false });
  });

  test('service saturé (503) : erreur transitoire, réessayable', async () => {
    const s = stub(503, fixture('ocr-response.503.json'));
    const err = await new HttpOcrClient('http://ocr:8080', 1000, s.fetch).ocr(Buffer.from('%PDF')).catch((e) => e);
    expect(err).toMatchObject({ code: 'busy', retryable: true });
  });

  test('délai dépassé : erreur transitoire', async () => {
    const f = (async () => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const err = await new HttpOcrClient('http://ocr:8080', 10, f).ocr(Buffer.from('%PDF')).catch((e) => e);
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  test('réponse non conforme : refusée', async () => {
    const s = stub(200, JSON.stringify({ text: 'x' }));
    const err = await new HttpOcrClient('http://ocr:8080', 1000, s.fetch).ocr(Buffer.from('%PDF')).catch((e) => e);
    expect(err).toMatchObject({ code: 'bad_response' });
  });
});
