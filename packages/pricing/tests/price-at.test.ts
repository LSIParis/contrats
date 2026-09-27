import { describe, test, expect } from 'vitest';
import { priceAt, selectSchedule, PricingError, FormulaError, type PricingResult, type TraceStep } from '../src/index.js';
import { input, line, schedule } from './fixtures.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as PricingError).code;
  }
  return undefined;
};

const lineOf = (r: PricingResult, id: string) => {
  const l = r.lines.find((x) => x.lineId === id);
  if (!l) throw new Error(`ligne ${id} absente`);
  return l;
};

const stepsOf = <T extends TraceStep['type']>(r: PricingResult, id: string, type: T) =>
  lineOf(r, id).trace.filter((s): s is Extract<TraceStep, { type: T }> => s.type === type);

describe('selectSchedule — barèmes versionnés', () => {
  const v1 = schedule([], { id: 'v1', validFrom: '2025-01-01', validTo: '2025-12-31' });
  const v2 = schedule([], { id: 'v2', validFrom: '2026-01-01', validTo: null });

  test('retient la version valide à la date (bornes incluses)', () => {
    expect(selectSchedule([v1, v2], '2025-12-31').id).toBe('v1');
    expect(selectSchedule([v1, v2], '2026-01-01').id).toBe('v2');
    expect(selectSchedule([v2, v1], '2030-06-01').id).toBe('v2');
  });
  test('aucune version → NO_SCHEDULE ; chevauchement → OVERLAPPING_SCHEDULES', () => {
    expect(codeOf(() => selectSchedule([v1, v2], '2024-12-31'))).toBe('NO_SCHEDULE');
    const v1bis = schedule([], { id: 'v1bis', validFrom: '2025-06-01', validTo: '2026-06-30' });
    expect(codeOf(() => selectSchedule([v1, v2, v1bis], '2025-07-01'))).toBe('OVERLAPPING_SCHEDULES');
  });
  test('période inversée → INVALID_DATE', () => {
    expect(codeOf(() => selectSchedule([schedule([], { validFrom: '2026-01-01', validTo: '2025-01-01' })], '2025-06-01'))).toBe(
      'INVALID_DATE',
    );
  });
});

describe('priceAt — types de lignes (mode MANUAL)', () => {
  test('UNIT : 12 postes × 35 € ; HT / TVA / TTC', () => {
    const r = priceAt(input([line({ id: 'postes', unitPrice: '35', quantity: { source: 'FIXED', value: '12' } })]), '2026-01-15');
    const l = lineOf(r, 'postes');
    expect(l).toMatchObject({ unitPrice: '35.000000', quantity: '12', totalHtCents: 42000n, recurrence: 'MONTHLY', vatRatePercent: '20' });
    expect(r.totals).toMatchObject({ htCents: 42000n, vatCents: 8400n, ttcCents: 50400n });
    expect(r.totals.vatByRate).toEqual([{ ratePercent: '20', baseHtCents: 42000n, vatCents: 8400n }]);
    expect(r).toMatchObject({ date: '2026-01-15', scheduleId: 's1', currency: 'EUR' });
  });

  test('forfaits mensuel et annuel, frais de mise en service : ventilation récurrent / ponctuel', () => {
    const r = priceAt(
      input([
        line({ id: 'infog', kind: 'FLAT_MONTHLY', unitPrice: '490' }),
        line({ id: 'sauvegarde', kind: 'FLAT_YEARLY', unitPrice: '1000' }),
        line({ id: 'mes', kind: 'SETUP_FEE', unitPrice: '750' }),
      ]),
      '2026-01-15',
    );
    expect(lineOf(r, 'infog').recurrence).toBe('MONTHLY');
    expect(lineOf(r, 'sauvegarde').recurrence).toBe('YEARLY');
    expect(lineOf(r, 'mes').recurrence).toBe('ONE_OFF');
    expect(r.totals).toMatchObject({
      htCents: 224000n,
      monthlyLinesCents: 49000n,
      yearlyLinesCents: 100000n,
      oneOffCents: 75000n,
      // 490 + 1000/12 = 490 + 83.333… → 573.33 (arrondi une seule fois, sur la part annuelle)
      monthlyRecurringCents: 57333n,
      // 490 × 12 + 1000
      annualRecurringCents: 688000n,
    });
  });

  test('récurrence TRIMESTRIELLE (lot 9) : ventilée à part, normalisée au mois et à l’année', () => {
    const r = priceAt(
      input([
        line({ id: 'infog', kind: 'FLAT_MONTHLY', unitPrice: '490' }),
        line({ id: 'test-resto', kind: 'UNIT', recurrence: 'QUARTERLY', unitPrice: '150' }),
        line({ id: 'sauvegarde', kind: 'FLAT_YEARLY', unitPrice: '1000' }),
      ]),
      '2026-01-15',
    );
    expect(lineOf(r, 'test-resto').recurrence).toBe('QUARTERLY');
    expect(r.totals).toMatchObject({
      htCents: 164000n,
      monthlyLinesCents: 49000n,
      quarterlyLinesCents: 15000n,
      yearlyLinesCents: 100000n,
      oneOffCents: 0n,
      // 490 + 150/3 + 1000/12 = 490 + 50 + 83.333… → 623.33
      monthlyRecurringCents: 62333n,
      // 490 × 12 + 150 × 4 + 1000
      annualRecurringCents: 748000n,
    });
    // Un forfait mensuel reste mensuel : la récurrence imposée ne se contredit pas.
    expect(codeOf(() => priceAt(input([line({ id: 'x', kind: 'FLAT_MONTHLY', recurrence: 'QUARTERLY', unitPrice: '1' })]), '2026-01-15'))).toBe(
      'INVALID_LINE',
    );
  });

  test('HOURLY : 1,5 h × 80 € ; HOUR_PACK : taux horaire effectif tracé', () => {
    const r = priceAt(
      input([
        line({ id: 'regie', kind: 'HOURLY', unit: 'heure', unitPrice: '80', quantity: { source: 'FIXED', value: '1.5' } }),
        line({ id: 'pack', kind: 'HOUR_PACK', unit: 'pack', unitPrice: '900', hourPack: { hoursPerPack: '12' } }),
      ]),
      '2026-01-15',
    );
    expect(lineOf(r, 'regie')).toMatchObject({ totalHtCents: 12000n, recurrence: 'ONE_OFF' });
    expect(lineOf(r, 'pack')).toMatchObject({ totalHtCents: 90000n, recurrence: 'ONE_OFF' });
    expect(stepsOf(r, 'pack', 'HOUR_PACK')).toEqual([{ type: 'HOUR_PACK', hoursPerPack: '12', effectiveHourlyRate: '75.000000' }]);
  });

  test('récurrence imposée par le type : contradiction → INVALID_LINE', () => {
    expect(codeOf(() => priceAt(input([line({ id: 'x', kind: 'SETUP_FEE', unitPrice: '1', recurrence: 'MONTHLY' })]), '2026-01-01'))).toBe(
      'INVALID_LINE',
    );
  });

  test('récurrence surchargeable pour UNIT (licence annuelle)', () => {
    const r = priceAt(input([line({ id: 'lic', unitPrice: '120', recurrence: 'YEARLY' })]), '2026-01-01');
    expect(r.totals.monthlyRecurringCents).toBe(1000n);
  });

  test('TIERED manuel GRADUATED', () => {
    const r = priceAt(
      input([
        line({
          id: 'sup',
          kind: 'TIERED',
          quantity: { source: 'FIXED', value: '12' },
          tiers: {
            mode: 'GRADUATED',
            tiers: [
              { upTo: '10', unitPrice: '30' },
              { upTo: null, unitPrice: '25' },
            ],
          },
        }),
      ]),
      '2026-01-01',
    );
    expect(lineOf(r, 'sup')).toMatchObject({ totalHtCents: 35000n, unitPrice: '29.166667' });
    expect(stepsOf(r, 'sup', 'TIERS')[0]).toMatchObject({ tierMode: 'GRADUATED', amount: '350', ruleId: null });
  });

  test('configurations incohérentes → INVALID_LINE, avec l’identifiant de la ligne', () => {
    const cases = [
      line({ id: 'sans-prix' }),
      line({ id: 'tiered-sans-paliers', kind: 'TIERED' }),
      line({ id: 'formule-paliers', kind: 'TIERED', mode: 'FORMULA', formula: { expression: '1' } }),
      line({ id: 'pack-sans-heures', kind: 'HOUR_PACK', unitPrice: '1' }),
      line({ id: 'rule-sans-regle', mode: 'RULE' }),
      line({ id: 'formule-revision', mode: 'FORMULA', formula: { expression: '1' }, revision: { indexCode: 'SYNTEC', a: '0', b: '1', referenceDate: '2025-09-01', revisionDate: '2026-09-01' } }),
    ];
    for (const l of cases) {
      try {
        priceAt(input([l]), '2026-01-01');
        expect.fail(l.id);
      } catch (e) {
        expect((e as PricingError).code, l.id).toBe('INVALID_LINE');
        expect((e as PricingError).details.lineId, l.id).toBe(l.id);
      }
    }
  });

  test('identifiants de ligne en double → INVALID_LINE', () => {
    expect(codeOf(() => priceAt(input([line({ id: 'a', unitPrice: '1' }), line({ id: 'a', unitPrice: '2' })]), '2026-01-01'))).toBe(
      'INVALID_LINE',
    );
  });

  test('date invalide → INVALID_DATE', () => {
    expect(codeOf(() => priceAt(input([]), '2026-02-30'))).toBe('INVALID_DATE');
  });
});

describe('priceAt — mode RULE', () => {
  const ruleCatalog = {
    rules: [
      { id: 'grille', type: 'GRID' as const, entries: [{ articleCode: 'POSTE', unitPrice: '35' }] },
      { id: 'vol', type: 'VOLUME_DISCOUNT' as const, thresholds: [{ minQuantity: '20', percent: '5' }] },
      { id: 'eng', type: 'COMMITMENT_DISCOUNT' as const, thresholds: [{ minMonths: 24, percent: '3' }] },
      {
        id: 'paliers',
        type: 'TIERS' as const,
        table: {
          mode: 'VOLUME' as const,
          tiers: [
            { upTo: '10', unitPrice: '30' },
            { upTo: null, unitPrice: '25' },
          ],
        },
      },
    ],
  };

  test('grille + remise volume + remise d’engagement, en cascade', () => {
    const r = priceAt(
      input(
        [
          line({
            id: 'p',
            code: 'POSTE',
            mode: 'RULE',
            quantity: { source: 'FIXED', value: '25' },
            rule: { priceRuleId: 'grille', adjustmentRuleIds: ['vol', 'eng'] },
          }),
        ],
        { ruleCatalog, context: { commitmentMonths: 36 } },
      ),
      '2026-01-01',
    );
    // 35 × 0,95 × 0,97 = 32,2525 ; × 25 = 806,3125 → 806,31
    expect(lineOf(r, 'p')).toMatchObject({ unitPrice: '32.252500', totalHtCents: 80631n });
    expect(stepsOf(r, 'p', 'RULE_PRICE')).toEqual([{ type: 'RULE_PRICE', ruleId: 'grille', articleCode: 'POSTE', unitPrice: '35' }]);
    expect(stepsOf(r, 'p', 'ADJUSTMENT').map((s) => [s.ruleId, s.percent, s.after])).toEqual([
      ['vol', '5', '33.25'],
      ['eng', '3', '32.2525'],
    ]);
  });

  test('paliers issus du catalogue', () => {
    const r = priceAt(
      input([line({ id: 't', kind: 'TIERED', mode: 'RULE', quantity: { source: 'FIXED', value: '11' }, rule: { priceRuleId: 'paliers' } })], {
        ruleCatalog,
      }),
      '2026-01-01',
    );
    expect(lineOf(r, 't').totalHtCents).toBe(27500n);
    expect(stepsOf(r, 't', 'TIERS')[0]?.ruleId).toBe('paliers');
  });

  test('règle de paliers sur une ligne non TIERED (et inversement) → INVALID_LINE', () => {
    expect(
      codeOf(() => priceAt(input([line({ id: 'x', mode: 'RULE', rule: { priceRuleId: 'paliers' } })], { ruleCatalog }), '2026-01-01')),
    ).toBe('INVALID_LINE');
    expect(
      codeOf(() => priceAt(input([line({ id: 'x', kind: 'TIERED', mode: 'RULE', rule: { priceRuleId: 'grille' } })], { ruleCatalog }), '2026-01-01')),
    ).toBe('INVALID_LINE');
  });

  test('règle absente → RULE_NOT_FOUND', () => {
    expect(codeOf(() => priceAt(input([line({ id: 'x', mode: 'RULE', rule: { priceRuleId: 'nope' } })], { ruleCatalog }), '2026-01-01'))).toBe(
      'RULE_NOT_FOUND',
    );
  });
});

describe('priceAt — mode FORMULA', () => {
  test('formule avec constantes, quantité et indices liés', () => {
    const r = priceAt(
      input([
        line({
          id: 'f',
          kind: 'FLAT_MONTHLY',
          mode: 'FORMULA',
          formula: {
            expression: 'round(P0 * (a + b * S1 / S0), 2)',
            basePrice: '1250.00',
            variables: { a: '0.15', b: '0.85' },
            indexVariables: {
              S0: { indexCode: 'SYNTEC', date: '2025-09-15' },
              S1: { indexCode: 'SYNTEC', date: 'PRICING_DATE' },
            },
          },
        }),
      ]),
      '2026-09-15',
    );
    expect(lineOf(r, 'f')).toMatchObject({ unitPrice: '1288.670000', totalHtCents: 128867n });
    const f = stepsOf(r, 'f', 'FORMULA')[0];
    expect(f?.variables).toEqual({ P0: '1250', S0: '321.5', S1: '333.2', a: '0.15', b: '0.85', qty: '1' });
    expect(stepsOf(r, 'f', 'INDEX').map((s) => [s.variable, s.observation.period])).toEqual([
      ['S0', '2025-07'],
      ['S1', '2026-07'],
    ]);
  });

  test('variable inconnue → FormulaError FORMULA_UNKNOWN_VARIABLE, rattachée à la ligne', () => {
    try {
      priceAt(input([line({ id: 'f', mode: 'FORMULA', formula: { expression: 'x * 2' } })]), '2026-01-01');
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaError);
      expect((e as FormulaError).code).toBe('FORMULA_UNKNOWN_VARIABLE');
      expect((e as FormulaError).details.lineId).toBe('f');
    }
  });

  test('résultat négatif → NEGATIVE_PRICE ; collision de noms → INVALID_LINE', () => {
    expect(codeOf(() => priceAt(input([line({ id: 'f', mode: 'FORMULA', formula: { expression: '0 - 1' } })]), '2026-01-01'))).toBe(
      'NEGATIVE_PRICE',
    );
    expect(
      codeOf(() =>
        priceAt(input([line({ id: 'f', mode: 'FORMULA', formula: { expression: 'qty', variables: { qty: '3' } } })]), '2026-01-01'),
      ),
    ).toBe('INVALID_LINE');
  });

  test('indice manquant → INDEX_VALUE_NOT_FOUND (jamais de valeur devinée)', () => {
    expect(
      codeOf(() =>
        priceAt(
          input([
            line({
              id: 'f',
              mode: 'FORMULA',
              formula: { expression: 'S1', indexVariables: { S1: { indexCode: 'SYNTEC', date: 'PRICING_DATE' } } },
            }),
          ]),
          '2025-01-01',
        ),
      ),
    ).toBe('INDEX_VALUE_NOT_FOUND');
  });
});

describe('priceAt — révision native (exemple documenté 04-tarification.md §6.3)', () => {
  const revised = line({
    id: 'infog',
    kind: 'FLAT_MONTHLY',
    unitPrice: '1250.00',
    revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-01' },
  });

  test('P0 = 1250,00 € ; S0 = 321,5 ; S1 = 333,2 → 1288,666407 € → 1288,67 € HT', () => {
    const r = priceAt(input([revised]), '2026-09-15');
    const l = lineOf(r, 'infog');
    expect(l.unitPrice).toBe('1288.666407');
    expect(l.totalHtCents).toBe(128867n);
    expect(stepsOf(r, 'infog', 'REVISION')[0]).toMatchObject({
      P0: '1250',
      a: '0.15',
      b: '0.85',
      S0: { period: '2025-07', value: '321.5' },
      S1: { period: '2026-07', value: '333.2' },
      ratio: '1.036391912908242612752721617418351477449',
      coefficient: '1.030933125972006220839813374805598755832',
      result: '1288.66640746500777604976671850699844479',
    });
    expect(stepsOf(r, 'infog', 'ROUNDING')).toEqual([
      { type: 'ROUNDING', target: 'UNIT_PRICE', exact: '1288.66640746500777604976671850699844479', rounded: '1288.666407', scale: 6, mode: 'HALF_AWAY_FROM_ZERO' },
      { type: 'ROUNDING', target: 'LINE_TOTAL', exact: '1288.666407', rounded: '1288.67', scale: 2, mode: 'HALF_AWAY_FROM_ZERO' },
    ]);
    // TVA 20 % sur 1288,67 = 257,734 → 257,73 ; TTC 1546,40
    expect(r.totals).toMatchObject({ htCents: 128867n, vatCents: 25773n, ttcCents: 154640n });
  });

  test('prix unitaire arrondi au centime (unitPriceScale = 2) : même total', () => {
    const r = priceAt(input([revised], { settings: { unitPriceScale: 2 } }), '2026-09-15');
    expect(lineOf(r, 'infog')).toMatchObject({ unitPrice: '1288.67', totalHtCents: 128867n });
  });

  test('exemple 2 (§6.4) : 12 postes à P0 = 35,00 € — l’échelle du prix unitaire compte', () => {
    const postes = line({
      id: 'postes',
      unitPrice: '35.00',
      quantity: { source: 'FIXED', value: '12' },
      revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-01' },
    });
    // unitPriceScale = 6 : 36,082659 × 12 = 432,991908 → 432,99
    const r6 = priceAt(input([postes]), '2026-09-15');
    expect(lineOf(r6, 'postes')).toMatchObject({ unitPrice: '36.082659', totalHtCents: 43299n });
    expect(stepsOf(r6, 'postes', 'REVISION')[0]?.result).toBe('36.08265940902021772939346811819595645412');
    // unitPriceScale = 2 : 36,08 × 12 = 432,96
    const r2 = priceAt(input([postes], { settings: { unitPriceScale: 2 } }), '2026-09-15');
    expect(lineOf(r2, 'postes')).toMatchObject({ unitPrice: '36.08', totalHtCents: 43296n });
  });

  test('avant la date de révision : P0, et la trace le dit', () => {
    const r = priceAt(input([revised]), '2026-08-31');
    expect(lineOf(r, 'infog').totalHtCents).toBe(125000n);
    expect(stepsOf(r, 'infog', 'REVISION_NOT_EFFECTIVE')).toEqual([
      { type: 'REVISION_NOT_EFFECTIVE', revisionDate: '2026-09-01', date: '2026-08-31' },
    ]);
  });

  test('a + b ≠ 1 → INVALID_REVISION_COEFFICIENTS', () => {
    const bad = line({ ...revised, revision: { ...revised.revision!, b: '0.84' } });
    expect(codeOf(() => priceAt(input([bad]), '2026-09-15'))).toBe('INVALID_REVISION_COEFFICIENTS');
  });
});

describe('priceAt — quantités fournies', () => {
  const l = line({ id: 'postes', unitPrice: '35', quantity: { source: 'PROVIDER' } });

  test('lue dans input.quantities, provenance tracée', () => {
    const r = priceAt(
      input([l], { quantities: [{ lineId: 'postes', quantity: '42', source: 'rmm:fake', observedAt: '2026-01-14T23:00:00Z' }] }),
      '2026-01-15',
    );
    expect(lineOf(r, 'postes').totalHtCents).toBe(147000n);
    expect(stepsOf(r, 'postes', 'QUANTITY')).toEqual([
      { type: 'QUANTITY', source: 'rmm:fake', quantity: '42', observedAt: '2026-01-14T23:00:00Z' },
    ]);
  });

  test('absente → MISSING_QUANTITY', () => {
    expect(codeOf(() => priceAt(input([l]), '2026-01-15'))).toBe('MISSING_QUANTITY');
  });

  test('négative → INVALID_DECIMAL', () => {
    expect(
      codeOf(() => priceAt(input([l], { quantities: [{ lineId: 'postes', quantity: '-1', source: 'x', observedAt: null }] }), '2026-01-15')),
    ).toBe('INVALID_DECIMAL');
  });
});

describe('priceAt — dérogations', () => {
  const base = line({ id: 'p', unitPrice: '100' });
  const ov = {
    id: 'o1',
    lineId: 'p',
    unitPrice: '95',
    validFrom: '2026-01-01',
    validTo: '2026-03-31',
    reason: 'Geste commercial',
    authorId: 'alice',
    approvedBy: null,
  };

  test('appliquée dans sa période, tracée', () => {
    const r = priceAt(input([base], { overrides: [ov] }), '2026-02-01');
    expect(lineOf(r, 'p')).toMatchObject({ unitPrice: '95.000000', totalHtCents: 9500n });
    expect(stepsOf(r, 'p', 'OVERRIDE_APPLIED')[0]).toMatchObject({
      overrideId: 'o1',
      computedUnitPrice: '100.000000',
      unitPrice: '95',
      gapPercent: '5',
      requiresSecondApproval: false,
      reason: 'Geste commercial',
    });
  });

  test('hors période : prix calculé', () => {
    expect(lineOf(priceAt(input([base], { overrides: [ov] }), '2026-04-01'), 'p').totalHtCents).toBe(10000n);
  });

  test('au-delà du seuil sans second validateur : ignorée et tracée', () => {
    const r = priceAt(input([base], { overrides: [{ ...ov, unitPrice: '80' }] }), '2026-02-01');
    expect(lineOf(r, 'p').totalHtCents).toBe(10000n);
    expect(stepsOf(r, 'p', 'OVERRIDE_SKIPPED')).toEqual([
      { type: 'OVERRIDE_SKIPPED', overrideId: 'o1', reason: 'REQUIRES_SECOND_APPROVAL', gapPercent: '20' },
    ]);
  });

  test('seuil paramétrable', () => {
    const r = priceAt(input([base], { overrides: [{ ...ov, unitPrice: '80' }], settings: { overrideApprovalThresholdPercent: '25' } }), '2026-02-01');
    expect(lineOf(r, 'p').totalHtCents).toBe(8000n);
  });

  test('sur une ligne en paliers : prix unitaire plat × quantité', () => {
    const t = line({
      id: 'p',
      kind: 'TIERED',
      quantity: { source: 'FIXED', value: '4' },
      tiers: { mode: 'VOLUME', tiers: [{ upTo: null, unitPrice: '100' }] },
    });
    expect(lineOf(priceAt(input([t], { overrides: [ov] }), '2026-02-01'), 'p').totalHtCents).toBe(38000n);
  });
});

describe('priceAt — remises', () => {
  const a = line({ id: 'a', unitPrice: '100' });
  const b = line({ id: 'b', unitPrice: '50' });

  test('remise en % sur des lignes désignées', () => {
    const r = priceAt(
      input([a, b, line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '10', appliesTo: { scope: 'LINES', lineIds: ['a'] } } })]),
      '2026-01-01',
    );
    expect(lineOf(r, 'r')).toMatchObject({ totalHtCents: -1000n, unitPrice: '-10.00', quantity: '1', recurrence: 'MONTHLY' });
    expect(r.totals.htCents).toBe(14000n);
    expect(stepsOf(r, 'r', 'DISCOUNT')[0]).toMatchObject({ targetLineIds: ['a'], baseHtCents: '10000' });
  });

  test('remise en montant sur le sous-total', () => {
    const r = priceAt(
      input([a, b, line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'AMOUNT', value: '15.50', appliesTo: { scope: 'SUBTOTAL' } } })]),
      '2026-01-01',
    );
    expect(lineOf(r, 'r').totalHtCents).toBe(-1550n);
    expect(r.totals).toMatchObject({ htCents: 13450n, vatCents: 2690n, ttcCents: 16140n });
  });

  test('arrondi d’une remise négative : demi à l’écart de zéro (symétrique), ou au pair', () => {
    // 10 % de 0,05 € = 0,005 € = 0,5 centime
    const tiny = [line({ id: 'a', unitPrice: '0.05' }), line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '10', appliesTo: { scope: 'SUBTOTAL' } } })];
    expect(lineOf(priceAt(input(tiny), '2026-01-01'), 'r').totalHtCents).toBe(-1n);
    expect(lineOf(priceAt(input(tiny, { settings: { rounding: 'HALF_EVEN' } }), '2026-01-01'), 'r').totalHtCents).toBe(0n);
  });

  test('cibles de TVA ou de récurrence différentes → DISCOUNT_TARGET_MISMATCH', () => {
    const c = line({ id: 'c', unitPrice: '10', vatRatePercent: '5.5' });
    const s = line({ id: 's', kind: 'SETUP_FEE', unitPrice: '10' });
    const d = line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '10', appliesTo: { scope: 'SUBTOTAL' } } });
    expect(codeOf(() => priceAt(input([a, c, d]), '2026-01-01'))).toBe('DISCOUNT_TARGET_MISMATCH');
    expect(codeOf(() => priceAt(input([a, s, d]), '2026-01-01'))).toBe('DISCOUNT_TARGET_MISMATCH');
    const d55 = line({ id: 'r', kind: 'DISCOUNT', vatRatePercent: '5.5', discount: { type: 'PERCENT', value: '10', appliesTo: { scope: 'LINES', lineIds: ['a'] } } });
    expect(codeOf(() => priceAt(input([a, d55]), '2026-01-01'))).toBe('DISCOUNT_TARGET_MISMATCH');
  });

  test('remise supérieure à sa base → DISCOUNT_EXCEEDS_BASE ; cible inconnue ou remise ciblée → INVALID_LINE', () => {
    expect(
      codeOf(() =>
        priceAt(input([a, line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'AMOUNT', value: '100.01', appliesTo: { scope: 'SUBTOTAL' } } })]), '2026-01-01'),
      ),
    ).toBe('DISCOUNT_EXCEEDS_BASE');
    expect(
      codeOf(() => priceAt(input([a, line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '101', appliesTo: { scope: 'SUBTOTAL' } } })]), '2026-01-01')),
    ).toBe('DISCOUNT_EXCEEDS_BASE');
    expect(
      codeOf(() =>
        priceAt(input([a, line({ id: 'r', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '1', appliesTo: { scope: 'LINES', lineIds: ['zz'] } } })]), '2026-01-01'),
      ),
    ).toBe('INVALID_LINE');
    expect(
      codeOf(() =>
        priceAt(
          input([
            a,
            line({ id: 'r1', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '1', appliesTo: { scope: 'SUBTOTAL' } } }),
            line({ id: 'r2', kind: 'DISCOUNT', discount: { type: 'PERCENT', value: '1', appliesTo: { scope: 'LINES', lineIds: ['r1'] } } }),
          ]),
          '2026-01-01',
        ),
      ),
    ).toBe('INVALID_LINE');
  });
});

describe('priceAt — arrondis et TVA', () => {
  test('total de ligne x,xx5 : demi à l’écart de zéro par défaut, demi au pair en option', () => {
    const l = [line({ id: 'a', unitPrice: '0.005' }), line({ id: 'b', unitPrice: '0.015' })];
    const away = priceAt(input(l), '2026-01-01');
    expect([lineOf(away, 'a').totalHtCents, lineOf(away, 'b').totalHtCents]).toEqual([1n, 2n]);
    const even = priceAt(input(l, { settings: { rounding: 'HALF_EVEN' } }), '2026-01-01');
    expect([lineOf(even, 'a').totalHtCents, lineOf(even, 'b').totalHtCents]).toEqual([0n, 2n]);
  });

  test('la TVA se calcule par taux sur la somme HT, pas ligne à ligne', () => {
    // Ligne à ligne : 0,03 × 20 % = 0,006 → 0,01, deux fois = 0,02.
    // Sur la somme : 0,06 × 20 % = 0,012 → 0,01.
    const r = priceAt(input([line({ id: 'a', unitPrice: '0.03' }), line({ id: 'b', unitPrice: '0.03' })]), '2026-01-01');
    expect(r.totals.vatCents).toBe(1n);
  });

  test('plusieurs taux : ventilation triée par taux croissant', () => {
    const r = priceAt(
      input([line({ id: 'a', unitPrice: '100' }), line({ id: 'b', unitPrice: '10.01', vatRatePercent: '5.5' }), line({ id: 'c', unitPrice: '3', vatRatePercent: '0' })]),
      '2026-01-01',
    );
    expect(r.totals.vatByRate).toEqual([
      { ratePercent: '0', baseHtCents: 300n, vatCents: 0n },
      { ratePercent: '5.5', baseHtCents: 1001n, vatCents: 55n }, // 0,55055 → 0,55
      { ratePercent: '20', baseHtCents: 10000n, vatCents: 2000n },
    ]);
    expect(r.totals.ttcCents).toBe(11301n + 2055n);
  });

  test('taux de TVA hors [0, 100] → INVALID_LINE', () => {
    expect(codeOf(() => priceAt(input([line({ id: 'a', unitPrice: '1', vatRatePercent: '120' })]), '2026-01-01'))).toBe('INVALID_LINE');
  });

  test('paramètres invalides → INVALID_SETTINGS', () => {
    expect(codeOf(() => priceAt(input([], { settings: { unitPriceScale: 7 } }), '2026-01-01'))).toBe('INVALID_SETTINGS');
  });
});
