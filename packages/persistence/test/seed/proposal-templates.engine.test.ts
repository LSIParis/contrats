import { describe, expect, it } from 'vitest';
import { quoteProposal, type ProposalPricingDefinition } from '@lsi/pricing';
import { loadSeed } from '../../prisma/seed/proposal-templates/load';
import {
  blockingValidations,
  evaluate,
  runControlCases,
  type PricingEvaluator,
  type Selection,
} from '../../prisma/seed/proposal-templates/reference-pricing';
import type { ProposalTemplateSeed } from '../../prisma/seed/proposal-templates/schema';

/**
 * Annexe C, règle 6 — MÊME RÉSULTAT QUE LE MOTEUR.
 *
 * Le moteur de tarification de l'application (`@lsi/pricing`, `quoteProposal`
 * → `priceAt`) est adapté à l'interface `PricingEvaluator` de la spécification
 * de référence, puis confronté aux cas de contrôle chiffrés des quatre modèles.
 * `reference-pricing.ts` n'est JAMAIS appelé en production : c'est la
 * spécification. Une divergence se corrige dans le moteur, ou dans le JSON
 * avec un incrément de `seedVersion` — jamais en assouplissant ce test.
 */
const seed = loadSeed();

function definitionOf(t: ProposalTemplateSeed): ProposalPricingDefinition {
  return {
    choices: t.pricing.choices,
    lines: t.pricing.lines,
    rules: t.pricing.rules,
    vatRatePercent: t.vatRatePercent,
  };
}

const engine: PricingEvaluator = (t, sel) => {
  const q = quoteProposal(definitionOf(t), sel, { date: '2026-10-01' });
  return {
    monthlyCents: Number(q.monthly.htCents),
    oneTimeCents: Number(q.oneTime.htCents),
    yearlyCents: Number(q.yearly.htCents),
    commitmentTotalCents: Number(q.commitment.htCents),
    errors: [...q.errors],
  };
};

describe('moteur de tarification = cas de contrôle de l’annexe C', () => {
  for (const t of seed.templates) {
    it(`${t.slug} : runControlCases(template, moteur) est vide`, () => {
      expect(t.controlCases.length).toBeGreaterThan(0);
      expect(runControlCases(t, engine)).toEqual([]);
    });
  }

  it('chiffres du brief §12.11 : infogérance 1 515,00 € / 1 362,50 € HT par mois, 2 300,00 € de mise en service', () => {
    const t = seed.templates.find((x) => x.slug === 'infogerance')!;
    const q = { 'poste-travail': 50, serveur: 2, 'equipement-reseau': 5 };
    const m24 = quoteProposal(definitionOf(t), { choices: { engagement: '24' }, quantities: q }, { date: '2026-10-01' });
    const m36 = quoteProposal(definitionOf(t), { choices: { engagement: '36' }, quantities: q }, { date: '2026-10-01' });
    expect(m24.monthly.htCents).toBe(151500n);
    expect(m24.commitment.htCents).toBe(3636000n);
    expect(m36.monthly.htCents).toBe(136250n);
    expect(m36.commitment.htCents).toBe(4905000n);
    expect(m24.oneTime.htCents).toBe(230000n);
  });

  it('RSSI : remise combinée de 10 % portée par une ligne distincte (1 395,00 € et 6 885,00 € HT par mois)', () => {
    const t = seed.templates.find((x) => x.slug === 'rssi')!;
    const tpe = quoteProposal(definitionOf(t), { choices: { formule: 'TPE_PME' }, selectedOptions: ['dpo'] }, { date: '2026-10-01' });
    expect(tpe.lines.find((l) => l.key === 'remise-combinee')?.totalHtCents).toBe(-15500n);
    expect(tpe.monthly.htCents).toBe(139500n);
    const eti = quoteProposal(definitionOf(t), { choices: { formule: 'ETI' }, selectedOptions: ['dpo'] }, { date: '2026-10-01' });
    expect(eti.monthly.htCents).toBe(688500n);
  });

  it('présélection par effectif, erreurs de configuration et éléments bloquants identiques à la référence', () => {
    const cases: [string, Selection][] = [
      ['rssi', { context: { 'client.effectif': 120 } }],
      ['rssi', { choices: { formule: 'PME' }, selectedOptions: ['dpo'] }],
      ['supervision', { quantities: { 'serveur-supervise': 0, 'equipement-reseau': 0 } }],
      ['supervision', { quantities: { 'serveur-supervise': 1, 'equipement-reseau': 0 } }],
      ['sauvegarde-en-ligne', { quantities: { poste: 0, serveur: 1, hyperviseur: 0, nas: 0, 'm365-utilisateur': 0, stockage: 2, 'copie-secondaire': 3 }, selectedOptions: ['copie-secondaire'] }],
      ['infogerance', { context: { 'parc.nbPostes': 8, 'parc.nbServeurs': 1, 'parc.nbEquipementsReseau': 2 } }],
    ];
    for (const [slug, sel] of cases) {
      const t = seed.templates.find((x) => x.slug === slug)!;
      const ref = evaluate(t, sel);
      const q = quoteProposal(definitionOf(t), sel, { date: '2026-10-01' });
      expect(q.choices, slug).toEqual(ref.choices);
      expect(Number(q.monthly.htCents), slug).toBe(ref.monthlyCents);
      expect(q.errors.length > 0, `${slug} erreurs`).toBe(ref.errors.length > 0);
      // Éléments « à valider » retenus (lignes, règles, choix ; sections traitées à part).
      const refKeys = blockingValidations(t, sel).filter((b) => b.scope !== 'SECTION').map((b) => b.key).sort();
      expect(q.blockingValidations.map((b) => b.key).sort(), `${slug} bloquants`).toEqual(refKeys);
    }
  });
});
