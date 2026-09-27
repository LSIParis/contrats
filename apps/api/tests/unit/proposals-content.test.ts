import { describe, test, expect } from 'vitest';
import type { ProposalPricingDefinition } from '@lsi/pricing';
import { markdownToHtml } from '../../src/proposals/markdown.js';
import { docxToSections, readZipEntry } from '../../src/proposals/docx-import.js';
import { HtmlToDocxRenderer } from '../../src/documents/html-to-docx.renderer.js';
import { enforcePriceStatuses, validateInDefinition, withTemplateValidations } from '../../src/proposals/pricing-definition.js';
import { contentIssues, mergeValuesFor, renderSections, stableStringify } from '../../src/proposals/proposal-content.js';
import { hashToken, newOtp, newToken, otpHash, TOKEN_RE } from '../../src/proposals/proposal-links.js';
import { parisEndOfDay } from '../../src/proposals/proposal-send.service.js';

describe('markdown restreint des propositions', () => {
  test('titres, listes, tableaux, gras ; texte échappé, aucun script', () => {
    const html = markdownToHtml('# Titre\n\n- un **gras**\n- deux\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script> & co');
    expect(html).toContain('<h2>Titre</h2>');
    expect(html).toContain('<ul><li>un <strong>gras</strong></li><li>deux</li></ul>');
    expect(html).toContain('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp; co');
  });
});

describe('import Word (.docx → sections)', () => {
  test('un titre de niveau 1 ouvre une section ; paragraphes et listes deviennent du texte', async () => {
    const docx = await new HtmlToDocxRenderer().renderDocx(
      '<p>Préambule de la proposition.</p><h1>Votre contexte</h1><p>Parc de 20 postes.</p><ul><li>Irritant A</li></ul><h1>Notre offre</h1><h2>Support</h2><p>Illimité.</p>',
      'Proposition existante',
    );
    expect(readZipEntry(docx, 'word/document.xml')).not.toBeNull();
    const sections = docxToSections(docx);
    expect(sections.map((s) => s.title)).toEqual(['Introduction', 'Votre contexte', 'Notre offre']);
    const md = (sections[1]!.blocks[0]!.content as { markdown: string }).markdown;
    expect(md).toContain('Parc de 20 postes.');
    expect(md).toContain('Irritant A');
    expect((sections[2]!.blocks[0]!.content as { markdown: string }).markdown).toMatch(/## Support/);
    expect(sections.every((s) => s.kind === 'TEXT' && /^[a-z0-9-]+$/.test(s.key))).toBe(true);
  });

  test('un fichier qui n’est pas un .docx est refusé proprement', () => {
    expect(() => docxToSections(Buffer.from('pas un zip'))).toThrow(/illisible|Word/);
  });
});

const def: ProposalPricingDefinition = {
  vatRatePercent: 20,
  choices: [{ key: 'engagement', label: 'Durée', editableByClient: true, options: [{ value: '12', label: '12', default: true, commitmentMonths: 12 }, { value: '24', label: '24', commitmentMonths: 24 }] }],
  lines: [
    { key: 'a', label: 'Ligne A', kind: 'REQUIRED', unit: 'u', recurrence: 'MONTHLY', group: 'RECURRING', quantity: { default: 1, min: 1, editableByClient: true }, pricing: { unitPriceCents: 1000 }, priceStatus: 'TO_VALIDATE' },
    { key: 'b', label: 'Ligne B', kind: 'OPTIONAL', unit: 'u', recurrence: 'MONTHLY', group: 'OPTIONS', quantity: { default: 1, min: 1, editableByClient: true }, pricing: { unitPriceCents: 500 }, priceStatus: 'VALIDATED' },
  ],
  rules: [{ type: 'MINIMUM_MONTHLY', key: 'min', amountCents: 2000, label: 'Minimum', priceStatus: 'TO_VALIDATE' }],
};

describe('statuts « à valider » : jamais d’auto-validation', () => {
  test('un prix inchangé garde son statut ; un prix modifié ou nouveau repasse TO_VALIDATE', () => {
    const next = enforcePriceStatuses(
      {
        ...def,
        lines: [
          { ...def.lines[0]!, priceStatus: 'VALIDATED' },
          { ...def.lines[1]!, pricing: { unitPriceCents: 400 } },
          { ...def.lines[1]!, key: 'c', priceStatus: 'VALIDATED' },
        ],
        rules: [{ ...(def.rules[0] as any), priceStatus: 'VALIDATED' }],
      },
      def,
    );
    expect(next.lines.map((l) => [l.key, l.priceStatus])).toEqual([['a', 'TO_VALIDATE'], ['b', 'TO_VALIDATE'], ['c', 'TO_VALIDATE']]);
    expect((next.rules[0] as any).priceStatus).toBe('TO_VALIDATE');
  });

  test('validation par l’administrateur, élément par élément', () => {
    const v = validateInDefinition(def, { scope: 'LINE', key: 'a' })!;
    expect(v.lines[0]!.priceStatus).toBe('VALIDATED');
    expect(validateInDefinition(v, { scope: 'LINE', key: 'a' })).toBeNull();
    expect((validateInDefinition(def, { scope: 'RULE', key: 'min' })!.rules[0] as any).priceStatus).toBe('VALIDATED');
  });

  test('une validation du MODÈLE lève le statut seulement si le prix est le même', () => {
    const template = { ...def, lines: def.lines.map((l) => ({ ...l, priceStatus: 'VALIDATED' as const })) };
    expect(withTemplateValidations(def, template).lines[0]!.priceStatus).toBe('VALIDATED');
    const changed = { ...def, lines: [{ ...def.lines[0]!, pricing: { unitPriceCents: 999 } }, def.lines[1]!] };
    expect(withTemplateValidations(changed, template).lines[0]!.priceStatus).toBe('TO_VALIDATE');
  });
});

describe('contenu : balises, préparation, rendu', () => {
  const values = mergeValuesFor({
    customer: { name: 'Dupont', legalName: 'Dupont SAS', siren: '123456789' },
    contact: { firstName: 'Jeanne', lastName: 'Dupont' },
    ownerName: 'Sylvie M.',
    number: 'PROP-2026-0001',
    expiryDay: '2026-10-31',
    mergeContext: { 'parc.nbPostes': 12, 'mot.de.passe': 'secret', 'client.effectif': 'beaucoup' },
    quote: null,
  });

  test('seules les balises du catalogue entrent dans les valeurs', () => {
    expect(values).toMatchObject({ 'client.raisonSociale': 'Dupont SAS', 'parc.nbPostes': 12, 'commercial.nom': 'Sylvie M.' });
    expect(values).not.toHaveProperty('mot.de.passe');
  });

  test('balise sans valeur, balise inconnue, « [à compléter] », contexte vide, CGV absentes : autant de problèmes', () => {
    const sections = [
      { key: 's1', title: 'A', kind: 'TEXT', position: 0, optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: '{{parc.nbServeurs}}', aiPendingReview: false,
        blocks: [{ position: 0, type: 'RICH_TEXT', content: { markdown: '{{tarif.totalMensuelHT}} {{client.inconnu}} [à compléter]' } }] },
      { key: 's2', title: 'Contexte', kind: 'CLIENT_INPUT', position: 1, optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, aiPendingReview: false,
        blocks: [{ position: 0, type: 'RICH_TEXT', content: { markdown: ' ' } }] },
      { key: 's3', title: 'CGV', kind: 'TERMS', position: 2, optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, aiPendingReview: false,
        blocks: [{ position: 0, type: 'TERMS', content: {} }] },
      { key: 's4', title: 'Exclue {{x.y}}', kind: 'TEXT', position: 3, optional: true, excluded: true, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, aiPendingReview: false, blocks: [] },
    ];
    const codes = contentIssues('Titre', sections, values, false).map((i) => i.code).sort();
    expect(codes).toEqual(['MERGE_TAG', 'MISSING_TERMS', 'TO_COMPLETE', 'TO_COMPLETE', 'UNKNOWN_TAG']);
    // La consigne (guidance) n'est jamais contrôlée ni rendue : elle ne part pas chez le client.
    const html = renderSections(sections, values, { title: 'CGV', body: 'Article 1.' });
    expect(html.map((s) => s.key)).toEqual(['s1', 's2', 's3']);
    expect(JSON.stringify(html)).not.toContain('nbServeurs');
    expect(html[2]!.html).toContain('Article 1.');
  });

  test('empreinte : indépendante de l’ordre des clés', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2n, c: 'x' }] })).toBe(stableStringify({ a: [{ c: 'x', d: 2n }], b: 1 }));
  });
});

describe('jetons et codes', () => {
  test('jeton de 256 bits, seul son hachage est comparable ; code à 6 chiffres lié au lien', () => {
    const t = newToken();
    expect(TOKEN_RE.test(t.token)).toBe(true);
    expect(hashToken(t.token)).toBe(t.hash);
    expect(newToken().token).not.toBe(t.token);
    const o = newOtp('lien-1');
    expect(o.code).toMatch(/^\d{6}$/);
    expect(otpHash('lien-1', o.code)).toBe(o.hash);
    expect(otpHash('lien-2', o.code)).not.toBe(o.hash);
  });

  test('fin de journée à Paris, heure d’été comme d’hiver', () => {
    expect(parisEndOfDay('2026-07-15').toISOString()).toBe('2026-07-15T21:59:59.999Z');
    expect(parisEndOfDay('2026-12-15').toISOString()).toBe('2026-12-15T22:59:59.999Z');
  });
});
