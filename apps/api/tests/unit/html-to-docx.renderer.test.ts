import { describe, test, expect } from 'vitest';
import { HtmlToDocxRenderer } from '../../src/documents/html-to-docx.renderer.js';

describe('HtmlToDocxRenderer', () => {
  test('produit un DOCX valide (Buffer non vide, signature ZIP PK\\x03\\x04)', async () => {
    const buf = await new HtmlToDocxRenderer().renderDocx('<h1>Titre</h1><p>Corps</p>', 'Mon document');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(100);
    // Un .docx est une archive ZIP : les 4 premiers octets sont 50 4B 03 04.
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});
