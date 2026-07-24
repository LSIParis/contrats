import { describe, test, expect } from 'vitest';
import { HtmlToDocxRenderer, stripRemoteResources } from '../../src/documents/html-to-docx.renderer.js';

describe('HtmlToDocxRenderer', () => {
  test('produit un DOCX valide (Buffer non vide, signature ZIP PK\\x03\\x04)', async () => {
    const buf = await new HtmlToDocxRenderer().renderDocx('<h1>Titre</h1><p>Corps</p>', 'Mon document');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(100);
    // Un .docx est une archive ZIP : les 4 premiers octets sont 50 4B 03 04.
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  test('un titre contenant « < » (XML) ne fait pas planter et produit un DOCX valide', async () => {
    const buf = await new HtmlToDocxRenderer().renderDocx('<p>Corps</p>', 'Société <SARL> Dupont');
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  test('strippe les <img> distants (défense en profondeur SSRF)', () => {
    expect(stripRemoteResources('<p>a</p><img src="http://interne/secret.png" onerror="x"><p>b</p>')).toBe(
      '<p>a</p><p>b</p>',
    );
  });

  test("un <img> dans l'entrée ne fait pas planter le rendu et produit un DOCX valide", async () => {
    const buf = await new HtmlToDocxRenderer().renderDocx('<p>x</p><img src="http://interne/x.png">', 'T');
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});
