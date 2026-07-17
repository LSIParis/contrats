import { describe, test, expect } from 'vitest';
import { GotenbergRenderer } from '../../src/documents/gotenberg.renderer.js';

/**
 * Test d'INTÉGRATION contre le vrai Gotenberg.
 *
 * Les tests d'envoi utilisent un FakeRenderer : ils vérifient notre logique.
 * Celui-ci vérifie que notre APPEL est correct — deux choses différentes.
 * Un fake ne teste que notre compréhension de Gotenberg, pas Gotenberg.
 *
 * Exige `docker compose up -d`. Ignoré sinon, plutôt qu'échouer : un
 * développeur sans la pile ne doit pas voir une CI rouge qui ne le concerne
 * pas. Mais la CI, elle, DOIT avoir la pile — sinon ces tests ne servent à
 * rien (voir .github/workflows/ci.yml).
 */

const URL = process.env.GOTENBERG_URL ?? 'http://localhost:3003';

/**
 * Sonde de disponibilité au niveau MODULE, via top-level await.
 *
 * PAS dans beforeAll : `runIf` est évalué à la COLLECTE, donc avant que
 * beforeAll ait tourné. Une sonde dans beforeAll laisserait `available` à
 * false au moment où Vitest décide quoi exécuter, et les tests seraient
 * skippés en SILENCE — verts, et ne testant rien.
 *
 * C'est précisément le mode de défaillance que ces tests existent pour
 * éviter. Ils doivent tourner, ou dire clairement qu'ils ne tournent pas.
 */
const available = await (async () => {
  if (process.env.SKIP_INTEGRATION) return false;
  try {
    const res = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
})();

if (!available && !process.env.SKIP_INTEGRATION) {
  // Bruyant, et à dessein : un test d'intégration ignoré sans que personne
  // ne le sache est pire qu'un test absent — il donne l'illusion de la
  // couverture.
  console.warn(
    `\n⚠ Gotenberg injoignable sur ${URL} — tests d'intégration IGNORÉS.` +
      `\n  Lancez : docker compose up -d\n`,
  );
}

describe.runIf(available)('GotenbergRenderer — instance réelle', () => {
  test('produit un PDF réel depuis du HTML', async () => {
    const renderer = new GotenbergRenderer();

    const { pdf, sha256 } = await renderer.render({
      html: '<h1>Contrat de maintenance 2026</h1><p>Dupont SAS — 1 290 €/mois</p>',
      documentTitle: 'LSI-2026-0042',
    });

    // Un vrai PDF commence par %PDF- et finit par %%EOF.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produit du PDF/A — le format d’archivage (§11.2)', async () => {
    const renderer = new GotenbergRenderer();
    const { pdf } = await renderer.render({
      html: '<h1>Test PDF/A</h1>',
      documentTitle: 'archivage',
    });

    // PDF/A embarque des métadonnées XMP déclarant la conformité.
    // Un contrat qui ne s'affiche plus dans 8 ans n'est pas une preuve.
    const text = pdf.toString('latin1');
    expect(text).toMatch(/pdfaid|PDF\/A/i);
  });

  test('le hash correspond aux octets rendus', async () => {
    const renderer = new GotenbergRenderer();
    const { pdf, sha256 } = await renderer.render({ html: '<p>x</p>', documentTitle: 't' });

    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(sha256);
  });

  test('le JavaScript injecté ne s’exécute PAS (§13.3)', async () => {
    // Le corps des contrats est du HTML rédigé par LSI — donc dangereux par
    // nature. Chromium tourne sans JS et sans réseau : un script qui aurait
    // survécu à l'assainissement ne peut ni s'exécuter, ni exfiltrer.
    const renderer = new GotenbergRenderer();
    const { pdf } = await renderer.render({
      html: '<p id="x">AVANT</p><script>document.getElementById("x").textContent="APRÈS";</script>',
      documentTitle: 'xss',
    });

    const text = pdf.toString('latin1');
    // Si le JS s'était exécuté, le PDF contiendrait « APRÈS ».
    expect(text).not.toContain('APRÈS');
  });
});
