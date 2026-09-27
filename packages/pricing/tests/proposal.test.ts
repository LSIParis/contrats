import { describe, test, expect } from 'vitest';
import { priceAt, quoteProposal, listPendingValidations, type ProposalPricingDefinition } from '../src/index.js';

/**
 * Tableau de prix des propositions (lot 9) : configuration + calcul par le
 * moteur. Les cas de contrôle chiffrés des quatre modèles livrés sont vérifiés
 * par packages/persistence/test/seed/proposal-templates.engine.test.ts.
 */
const def: ProposalPricingDefinition = {
  vatRatePercent: 20,
  choices: [
    {
      key: 'engagement',
      label: 'Durée',
      editableByClient: true,
      options: [
        { value: '24', label: '24 mois', default: true, commitmentMonths: 24 },
        { value: '36', label: '36 mois', commitmentMonths: 36 },
      ],
    },
  ],
  lines: [
    {
      key: 'poste', label: 'Poste', kind: 'REQUIRED', unit: 'poste / mois', recurrence: 'MONTHLY', group: 'RECURRING',
      quantity: { default: '{{parc.nbPostes}}', min: 1, max: 500, editableByClient: true },
      pricing: { dependsOn: 'engagement', byChoice: { '24': 2500, '36': 2250 } }, priceStatus: 'VALIDATED',
    },
    {
      key: 'dpo', label: 'DPO', kind: 'OPTIONAL', unit: 'forfait / mois', recurrence: 'MONTHLY', group: 'OPTIONS',
      quantity: { default: 1, min: 1, max: 1, editableByClient: false },
      pricing: { unitPriceCents: 35000 }, priceStatus: 'TO_VALIDATE',
    },
    {
      key: 'test', label: 'Test trimestriel', kind: 'OPTIONAL', unit: 'forfait / trimestre', recurrence: 'QUARTERLY', group: 'OPTIONS',
      quantity: { default: 1, min: 1, max: 1, editableByClient: false },
      pricing: { unitPriceCents: 15000 }, priceStatus: 'VALIDATED',
    },
    {
      key: 'mes', label: 'Mise en service', kind: 'SETUP', unit: 'poste', recurrence: 'ONE_TIME', group: 'SETUP',
      quantity: { default: 0, min: 0, linkedTo: 'poste', editableByClient: false },
      pricing: { unitPriceCents: 3500 }, priceStatus: 'VALIDATED',
    },
    {
      key: 'regie', label: 'Régie', kind: 'INFO', unit: 'heure', recurrence: 'INFO', group: 'OUT_OF_SCOPE',
      pricing: { unitPriceCents: 9500 }, priceStatus: 'VALIDATED',
    },
  ],
  rules: [
    { type: 'MINIMUM_MONTHLY', key: 'minimum', amountCents: 24900, label: 'Complément minimum', priceStatus: 'VALIDATED' },
    {
      type: 'DISCOUNT_PERCENT', key: 'remise', percent: 10, appliesTo: ['poste', 'dpo'], when: 'dpo',
      label: 'Remise combinée', priceStatus: 'VALIDATED',
    },
  ],
};

const opts = { date: '2026-10-01' };

describe('quoteProposal', () => {
  test('lignes retenues, mise en service liée, totaux ponctuel / mensuel / engagement', () => {
    const q = quoteProposal(def, { quantities: { poste: 20 } }, opts);
    expect(q.errors).toEqual([]);
    expect(q.monthly.htCents).toBe(50000n);
    expect(q.monthly.vatCents).toBe(10000n);
    expect(q.monthly.ttcCents).toBe(60000n);
    expect(q.oneTime.htCents).toBe(70000n);
    expect(q.commitment.htCents).toBe(50000n * 24n);
    expect(q.lines.map((l) => l.key)).toEqual(['poste', 'mes']);
    expect(q.infoLines.map((l) => [l.key, l.unitPriceCents])).toEqual([['regie', 9500n]]);
  });

  test('le barème produit, recalculé par priceAt, donne exactement les mêmes totaux', () => {
    const q = quoteProposal(def, { quantities: { poste: 20 }, selectedOptions: ['dpo', 'test'] }, opts);
    const replay = priceAt({ schedules: [q.engineSchedule!] }, '2026-10-01');
    expect(replay.totals).toEqual(q.engineResult!.totals);
    // remise 10 % sur (20 × 25 + 350) = 85 € ; mensuel = 850 − 85 = 765 €
    expect(q.lines.find((l) => l.key === 'remise')?.totalHtCents).toBe(-8500n);
    expect(q.monthly.htCents).toBe(76500n);
    expect(q.quarterly.htCents).toBe(15000n);
    // 765 × 24 + 150 × 8
    expect(q.commitment.htCents).toBe(76500n * 24n + 15000n * 8n);
  });

  test('complément de minimum : ligne distincte, calculée par le moteur', () => {
    const q = quoteProposal(def, { quantities: { poste: 2 } }, opts);
    expect(q.monthly.htCents).toBe(24900n);
    expect(q.lines.find((l) => l.key === 'minimum')).toMatchObject({ group: 'MINIMUM', totalHtCents: 19900n });
    expect(q.engineSchedule!.lines.some((l) => l.id === 'minimum' && l.kind === 'FLAT_MONTHLY')).toBe(true);
  });

  test('quantités par défaut issues des balises ; balise absente = erreur', () => {
    expect(quoteProposal(def, { context: { 'parc.nbPostes': 12 } }, opts).quantities.poste).toBe(12);
    expect(quoteProposal(def, {}, opts).errors.join()).toMatch(/non résolue/);
  });

  test('bornes contrôlées côté serveur (quantité forgée, quantité non modifiable, option inconnue)', () => {
    expect(quoteProposal(def, { quantities: { poste: 501 } }, opts).errors.join()).toMatch(/maximum/);
    expect(quoteProposal(def, { quantities: { poste: 1.5 } }, opts).errors.join()).toMatch(/invalide/);
    expect(quoteProposal(def, { quantities: { poste: 5, dpo: 3 }, selectedOptions: ['dpo'] }, opts).errors.join()).toMatch(
      /maximum|non modifiable/,
    );
    expect(quoteProposal(def, { quantities: { poste: 5 }, selectedOptions: ['poste'] }, opts).errors.join()).toMatch(
      /pas une option/,
    );
    expect(quoteProposal(def, { quantities: { poste: 5 }, choices: { engagement: '48' } }, opts).errors.join()).toMatch(
      /valeur invalide/,
    );
  });

  test('un élément TO_VALIDATE retenu est bloquant ; non retenu, il ne l’est pas', () => {
    expect(quoteProposal(def, { quantities: { poste: 5 } }, opts).blockingValidations).toEqual([]);
    expect(
      quoteProposal(def, { quantities: { poste: 5 }, selectedOptions: ['dpo'] }, opts).blockingValidations.map((b) => b.key),
    ).toEqual(['dpo']);
    expect(listPendingValidations(def).map((p) => p.key)).toEqual(['dpo']);
  });
});
