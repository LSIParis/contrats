import { describe, expect, test } from 'vitest';
import { HtmlDescription, sanitizeDescription } from '../../src/common/html-description.js';
import { pricingTableHtml } from '../../src/proposals/proposal-content.js';

describe('description HTML', () => {
  test('balises de mise en forme conservées, scripts et attributs dangereux retirés', () => {
    expect(sanitizeDescription('<p style="color:red" onclick="x()">A <em>b</em><img src=x onerror=alert(1)></p><script>1</script>'))
      .toBe('<p>A <em>b</em></p>');
    expect(sanitizeDescription('<table><tr><td>1</td></tr></table>')).toBe('<table><tr><td>1</td></tr></table>');
    expect(sanitizeDescription('Texte & <b>gras</b>')).toBe('Texte &amp; <b>gras</b>');
  });

  test('vide → null, limite de 20 000 caractères après assainissement', () => {
    expect(HtmlDescription.parse('<p> </p>')).toBeNull();
    expect(HtmlDescription.parse('')).toBeNull();
    expect(HtmlDescription.safeParse(`<p>${'x'.repeat(20_000)}</p>`).success).toBe(false);
    // Les balises retirées ne comptent pas : 19 990 caractères utiles passent.
    expect(HtmlDescription.safeParse(`<script>${'y'.repeat(500)}</script><p>${'x'.repeat(19_990)}</p>`).success).toBe(true);
  });

  test('PDF de la proposition : description sous le libellé, assainie au rendu', () => {
    const z = { htCents: 0n, vatCents: 0n, ttcCents: 0n };
    const html = pricingTableHtml(
      { lines: [{ key: 'a', label: 'Licence', recurrence: 'MONTHLY', quantity: 1, unit: 'u', unitPriceCents: 100n, totalHtCents: 100n, priceFrom: false }], infoLines: [], oneTime: z, monthly: z, quarterly: z, yearly: z, commitment: z, commitmentMonths: 12 } as never,
      { lines: [{ key: 'a', description: '<p>Inclus : <strong>Teams</strong></p><script>x</script>' }] },
    );
    expect(html).toContain('<td>Licence<div class="description"><p>Inclus : <strong>Teams</strong></p></div></td>');
    expect(html).not.toContain('<script>');
  });
});
