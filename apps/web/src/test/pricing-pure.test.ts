import { decimalFromInput, decimalToInput, formatCents, formatDecimal, formatDecimalEuros } from '../lib/money.js';
import { canDo } from '../lib/permissions.js';
import { describeStep } from '../features/pricing/labels.js';
import { draftFromLine, emptyDraft, lineFromDraft } from '../features/pricing/line-draft.js';
import type { LineInput } from '../features/pricing/types.js';

const NN = ' ';
const NB = ' ';

test('formatCents : chaînes de centimes, sans flottant, y compris au-delà de 2^53', () => {
  expect(formatCents('128867')).toBe(`1${NN}288,67${NB}€`);
  expect(formatCents('-5')).toBe(`-0,05${NB}€`);
  expect(formatCents('0')).toBe(`0,00${NB}€`);
  expect(formatCents('1500', { signed: true })).toBe(`+15,00${NB}€`);
  expect(formatCents('90071992547409931')).toBe(`900${NN}719${NN}925${NN}474${NN}099,31${NB}€`);
  expect(formatCents('abc')).toBe('—');
  expect(formatCents(null)).toBe('—');
});

test('formatDecimal : prix unitaires décimaux en euros', () => {
  expect(formatDecimal('1288.666407')).toBe(`1${NN}288,666407`);
  expect(formatDecimal('1250.000000')).toBe(`1${NN}250,00`);
  expect(formatDecimal('12', { minFraction: 0 })).toBe('12');
  expect(formatDecimalEuros('0.5')).toBe(`0,50${NB}€`);
});

test('decimalFromInput : normalise la saisie française, refuse le reste', () => {
  expect(decimalFromInput('1 250,5')).toBe('1250.5');
  expect(decimalFromInput('')).toBeUndefined();
  expect(decimalFromInput('12,1234567')).toBeNull();
  expect(decimalFromInput('-3')).toBeNull();
  expect(decimalFromInput('-3', { signed: true })).toBe('-3');
  expect(decimalToInput('0.15')).toBe('0,15');
});

test('canDo : la liste `permissions` de /v1/auth/me fait foi, sinon repli sur les rôles', () => {
  expect(canDo({ roles: ['MSP_ADMIN'], permissions: [] }, 'pricing.write')).toBe(false);
  expect(canDo({ roles: [], permissions: ['pricing.write'] }, 'pricing.write')).toBe(true);
  expect(canDo({ roles: ['ACCOUNT_MANAGER'] }, 'pricing.write')).toBe(true);
  expect(canDo({ roles: ['ACCOUNT_MANAGER'] }, 'pricing.override.approve')).toBe(false);
  expect(canDo(undefined, 'pricing.simulate')).toBe(false);
});

test('ligne MANUAL forfait mensuel avec révision Syntec → LineInput exact', () => {
  const d = {
    ...emptyDraft(1), lineKey: 'infogerance', articleCode: 'INFOG', label: 'Infogérance', unit: 'mois',
    unitPrice: '1 250,00', hasRevision: true, revIndexCode: 'SYNTEC', revA: '0,15', revB: '0,85',
    revReferenceDate: '2025-09-15', revRevisionDate: '2026-09-15',
  };
  expect(lineFromDraft(d)).toEqual({
    line: {
      lineKey: 'infogerance', articleCode: 'INFOG', label: 'Infogérance', unit: 'mois', kind: 'FLAT_MONTHLY', mode: 'MANUAL',
      vatRatePercent: '20', quantitySource: 'FIXED', quantity: '1', unitPrice: '1250.00',
      revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-15' },
    },
  });
});

test('ligne en paliers, ligne RULE, formule, remise, quantité fournie', () => {
  const tiered = lineFromDraft({
    ...emptyDraft(2), lineKey: 'postes', articleCode: 'POSTE', label: 'Postes', unit: 'poste', kind: 'TIERED', tierMode: 'VOLUME',
    quantity: '12', tiers: [{ upTo: '10', unitPrice: '30' }, { upTo: '', unitPrice: '25' }],
  });
  expect(tiered).toMatchObject({ line: { tiers: { mode: 'VOLUME', tiers: [{ upTo: '10', unitPrice: '30' }, { upTo: null, unitPrice: '25' }] } } });
  expect('line' in tiered && tiered.line.unitPrice).toBeFalsy();

  const rule = lineFromDraft({
    ...emptyDraft(3), lineKey: 'r', articleCode: 'POSTE', label: 'Poste', unit: 'poste', kind: 'UNIT', mode: 'RULE',
    priceRuleId: 'grille-2026', adjustmentRuleIds: ['volume'], quantitySource: 'PROVIDER', providerArticleCode: 'rmm:postes',
  });
  expect(rule).toEqual({
    line: {
      lineKey: 'r', articleCode: 'POSTE', label: 'Poste', unit: 'poste', kind: 'UNIT', mode: 'RULE', vatRatePercent: '20',
      quantitySource: 'PROVIDER', providerArticleCode: 'rmm:postes', rule: { priceRuleId: 'grille-2026', adjustmentRuleIds: ['volume'] },
    },
  });

  const formula = lineFromDraft({
    ...emptyDraft(4), lineKey: 'f', articleCode: 'F', label: 'Formule', unit: 'mois', mode: 'FORMULA', hasRevision: true,
    expression: 'base * (a + b * S1 / S0)', basePrice: '100', variables: [{ name: 'a', value: '0,15' }],
    indexVariables: [{ name: 'S1', indexCode: 'SYNTEC', date: 'PRICING_DATE', lookup: '' }],
  });
  expect(formula).toMatchObject({
    line: { formula: { expression: 'base * (a + b * S1 / S0)', basePrice: '100', variables: { a: '0.15' }, indexVariables: { S1: { indexCode: 'SYNTEC', date: 'PRICING_DATE' } } } },
  });
  // Révision native interdite en mode formule : jamais envoyée.
  expect('line' in formula && formula.line.revision).toBeUndefined();

  const discount = lineFromDraft({
    ...emptyDraft(5), lineKey: 'remise', articleCode: 'REM', label: 'Remise fidélité', unit: 'mois', kind: 'DISCOUNT', mode: 'RULE',
    discountType: 'PERCENT', discountValue: '10', discountScope: 'LINES', discountLineIds: ['infogerance'],
  });
  expect(discount).toEqual({
    line: {
      lineKey: 'remise', articleCode: 'REM', label: 'Remise fidélité', unit: 'mois', kind: 'DISCOUNT', mode: 'MANUAL', vatRatePercent: '20',
      discount: { type: 'PERCENT', value: '10', appliesTo: { scope: 'LINES', lineIds: ['infogerance'] } },
    },
  });
});

test('erreurs de forme : champs obligatoires et nombres invalides', () => {
  const r = lineFromDraft({ ...emptyDraft(1), label: 'X', articleCode: '', unitPrice: '12,x' });
  expect(r).toHaveProperty('errors');
  const errors = (r as { errors: string[] }).errors;
  expect(errors).toContain('X : code article obligatoire.');
  expect(errors.some((e) => e.includes('prix unitaire invalide'))).toBe(true);
});

test('aller-retour ligne → brouillon → ligne', () => {
  const l: LineInput = {
    lineKey: 'pack', articleCode: 'PACK10', label: 'Pack 10 h', unit: 'pack', kind: 'HOUR_PACK', mode: 'MANUAL', recurrence: 'ONE_OFF',
    vatRatePercent: '20', quantitySource: 'FIXED', quantity: '2', unitPrice: '800', hourPack: { hoursPerPack: '10' },
  };
  expect(lineFromDraft(draftFromLine(l))).toEqual({ line: l });
});

test('trace : étapes traduites en français, valeurs affichées sans recalcul', () => {
  expect(describeStep({ type: 'QUANTITY', source: 'FIXED', quantity: '12', observedAt: null })).toBe('Quantité : 12 (source FIXED)');
  expect(describeStep({
    type: 'REVISION', formula: 'P1 = P0 × (a + b × S1 / S0)', appliesTo: 'UNIT_PRICE', P0: '1250', a: '0.15', b: '0.85',
    S0: { indexCode: 'SYNTEC', period: '2025-06', value: '321.5', publishedAt: '2025-07-01' },
    S1: { indexCode: 'SYNTEC', period: '2026-06', value: '334.2', publishedAt: '2026-07-01' },
    ratio: '1.0395', coefficient: '1.0309', result: '1288.666407',
  })).toContain(`→ 1${NN}288,666407 €`);
  expect(describeStep({ type: 'OVERRIDE_SKIPPED', overrideId: 'o1', reason: 'REQUIRES_SECOND_APPROVAL', gapPercent: '24' }))
    .toBe('Dérogation écartée : seconde validation requise (écart 24 %)');
});
