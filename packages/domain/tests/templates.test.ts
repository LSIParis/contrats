import { describe, test, expect } from 'vitest';
import {
  extractVariables,
  validateVariables,
  renderVariables,
  VARIABLE_REGISTRY,
} from '../src/templates/variables.js';
import { diffClauses } from '../src/templates/clause-diff.js';
import { composeContractBody, documentFooterHtml } from '../src/templates/compose.js';

describe('variables typées', () => {
  test('extraction dédupliquée et triée, espaces tolérés', () => {
    expect(extractVariables('<p>{{ client.raisonSociale }} — {{contrat.dureeMois}} {{client.raisonSociale}}</p>'))
      .toEqual(['client.raisonSociale', 'contrat.dureeMois']);
  });

  test('le registre couvre les variables citées par le brief', () => {
    for (const v of ['client.raisonSociale', 'contrat.dureeMois', 'sla.delaiIntervention']) {
      expect(VARIABLE_REGISTRY).toHaveProperty([v]);
    }
  });

  test('validation Zod par type : entier, date, SIREN ; variables manquantes listées', () => {
    const r = validateVariables(['contrat.dureeMois', 'contrat.dateEffet', 'client.siren', 'client.raisonSociale'], {
      'contrat.dureeMois': 'douze', 'contrat.dateEffet': '2026-13-45', 'client.siren': '12345',
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['client.raisonSociale']);
    expect(r.invalid.map((i) => i.name).sort()).toEqual(['client.siren', 'contrat.dateEffet', 'contrat.dureeMois']);
  });

  test('valeurs valides acceptées, nombres transmis en chaîne coercés', () => {
    const r = validateVariables(['contrat.dureeMois', 'client.siren'], { 'contrat.dureeMois': '36', 'client.siren': '552100554' });
    expect(r).toMatchObject({ ok: true, missing: [], invalid: [] });
    expect(r.values['contrat.dureeMois']).toBe(36);
  });

  test('variable inconnue du registre : refusée sauf déclaration explicite du modèle', () => {
    expect(validateVariables(['projet.nom'], { 'projet.nom': 'X' }).unknown).toEqual(['projet.nom']);
    expect(validateVariables(['projet.nom'], { 'projet.nom': 'X' }, { 'projet.nom': 'string' }).ok).toBe(true);
  });

  test('rendu : valeurs ÉCHAPPÉES (pas d’injection HTML), dates au format français, manquantes signalées', () => {
    const r = renderVariables('<p>{{client.raisonSociale}} au {{contrat.dateEffet}} — {{client.siren}}</p>', {
      'client.raisonSociale': '<script>alert(1)</script> & Cie', 'contrat.dateEffet': '2026-09-01',
    });
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Cie');
    expect(r.html).toContain('1er septembre 2026');
    expect(r.html).toContain('[à compléter : client.siren]');
    expect(r.missing).toEqual(['client.siren']);
  });
});

describe('écarts par rapport au modèle (clauses dérogatoires)', () => {
  const tpl = [
    { key: 'OBJET', title: 'Objet', bodyHtml: '<p>Objet du contrat.</p>', required: true },
    { key: 'SLA', title: 'Niveaux de service', bodyHtml: '<p>Délai 4 h.</p>', required: false },
    { key: 'RGPD', title: 'Données personnelles', bodyHtml: '<p>Art. 28.</p>', required: true },
  ];

  test('identique au modèle (espaces près) : aucun écart', () => {
    const d = diffClauses(tpl, tpl.map((c) => ({ ...c, bodyHtml: c.bodyHtml.replace('.', ' .').replace(' .', '.') })));
    expect(d).toMatchObject({ added: [], removed: [], modified: [], hasDeviation: false });
  });

  test('clause modifiée, ajoutée, retirée — et retrait d’une clause obligatoire signalé', () => {
    const d = diffClauses(tpl, [
      tpl[0]!,
      { key: 'SLA', title: 'Niveaux de service', bodyHtml: '<p>Délai 8 h.</p>' },
      { key: 'PENALITES', title: 'Pénalités', bodyHtml: '<p>…</p>' },
    ]);
    expect(d.modified.map((m) => m.key)).toEqual(['SLA']);
    expect(d.added.map((a) => a.key)).toEqual(['PENALITES']);
    expect(d.removed).toEqual([{ key: 'RGPD', title: 'Données personnelles', required: true }]);
    expect(d.hasDeviation).toBe(true);
    expect(d.requiredRemoved).toBe(true);
  });

  test('sans modèle (contrat libre) : tout est « ajouté », rien n’est dérogatoire', () => {
    const d = diffClauses(null, tpl);
    expect(d.hasDeviation).toBe(false);
    expect(d.added).toHaveLength(0);
  });
});

describe('composition du document', () => {
  test('articles numérotés, annexes sur page séparée, référence en tête', () => {
    const html = composeContractBody({
      title: 'Contrat de maintenance',
      reference: 'LSI-2026-0042',
      clauses: [
        { title: 'Objet', bodyHtml: '<p>A</p>' },
        { title: 'Durée', bodyHtml: '<p>B</p>' },
      ],
      annexes: [{ title: 'Niveaux de service', html: '<p>SLA</p>' }],
    });
    expect(html).toMatch(/Article 1 — Objet[\s\S]*Article 2 — Durée/);
    expect(html).toContain('Annexe 1 — Niveaux de service');
    expect(html).toContain('page-break-before:always');
    expect(html).toContain('LSI-2026-0042');
  });

  test('titres échappés', () => {
    const html = composeContractBody({ title: 'A <b>&</b>', reference: 'R', clauses: [{ title: '<i>x</i>', bodyHtml: '' }], annexes: [] });
    expect(html).toContain('A &lt;b&gt;&amp;&lt;/b&gt;');
    expect(html).toContain('Article 1 — &lt;i&gt;x&lt;/i&gt;');
  });

  test('pied de page : référence et pagination Chromium', () => {
    const f = documentFooterHtml('LSI-2026-0042');
    expect(f).toContain('LSI-2026-0042');
    expect(f).toContain('<span class="pageNumber"></span>');
    expect(f).toContain('<span class="totalPages"></span>');
  });
});
