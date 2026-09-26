import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import {
  D,
  toCents,
  computeTiered,
  computeRevision,
  priceAt,
  type PricingInput,
  type PricingLine,
  type RoundingMode,
  type TierTable,
} from '../src/index.js';

/**
 * Tests de propriétés (fast-check). (brief §5 « monotonie des paliers,
 * non-régression des arrondis, idempotence de priceAt »)
 *
 * Chaque propriété est vérifiée sur plusieurs centaines d'entrées générées ;
 * en cas d'échec, fast-check réduit le contre-exemple au plus simple.
 */

/** Décimal positif ou nul en chaîne, avec au plus `maxScale` décimales. */
const decimalStr = (max: number, maxScale = 6) =>
  fc
    .tuple(fc.integer({ min: 0, max: max * 10 ** maxScale }), fc.integer({ min: 0, max: maxScale }))
    .map(([n, s]) => {
      // On tronque n à s décimales pour obtenir des échelles variées.
      const scaled = Math.floor(n / 10 ** (maxScale - s));
      return D(scaled).div(10 ** s).toFixed(s);
    });

const roundingMode = fc.constantFrom<RoundingMode>('HALF_AWAY_FROM_ZERO', 'HALF_EVEN');

/** Table de paliers valide : bornes strictement croissantes, dernier palier illimité ou non. */
const tierTable = (mode: 'GRADUATED' | 'VOLUME', decreasingPrices = false): fc.Arbitrary<TierTable> =>
  fc
    .tuple(
      fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 5 }),
      fc.array(decimalStr(500, 4), { minLength: 6, maxLength: 6 }),
    )
    .map(([bounds, prices]) => {
      const sorted = [...bounds].sort((a, b) => a - b);
      let ps = prices.slice(0, sorted.length + 1);
      if (decreasingPrices) ps = [...ps].sort((a, b) => D(b).comparedTo(D(a)));
      return {
        mode,
        tiers: [...sorted.map((upTo, i) => ({ upTo: String(upTo), unitPrice: ps[i] as string })), { upTo: null, unitPrice: ps[sorted.length] as string }],
      };
    });

describe('propriété — monotonie des paliers', () => {
  test('GRADUATED : plus de quantité ne fait jamais baisser le total (exact et arrondi)', () => {
    fc.assert(
      fc.property(tierTable('GRADUATED'), decimalStr(2000, 2), decimalStr(2000, 2), (table, a, b) => {
        const [q1, q2] = D(a).lte(D(b)) ? [D(a), D(b)] : [D(b), D(a)];
        const t1 = computeTiered(table, q1, 'l').exact;
        const t2 = computeTiered(table, q2, 'l').exact;
        expect(t1.lte(t2)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test('GRADUATED : l’arrondi au centime préserve la monotonie', () => {
    fc.assert(
      fc.property(tierTable('GRADUATED'), decimalStr(2000, 2), decimalStr(2000, 2), roundingMode, (table, a, b, mode) => {
        const [q1, q2] = D(a).lte(D(b)) ? [D(a), D(b)] : [D(b), D(a)];
        expect(toCents(computeTiered(table, q1, 'l').exact, mode) <= toCents(computeTiered(table, q2, 'l').exact, mode)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('VOLUME : le total N’EST PAS monotone en général — contre-exemple documenté', () => {
    const table: TierTable = { mode: 'VOLUME', tiers: [{ upTo: '10', unitPrice: '30' }, { upTo: null, unitPrice: '25' }] };
    expect(computeTiered(table, D(11), 'l').exact.lt(computeTiered(table, D(10), 'l').exact)).toBe(true);
  });

  test('VOLUME : monotone à l’intérieur d’un même palier', () => {
    fc.assert(
      fc.property(tierTable('VOLUME'), decimalStr(2000, 2), decimalStr(2000, 2), (table, a, b) => {
        const [q1, q2] = D(a).lte(D(b)) ? [D(a), D(b)] : [D(b), D(a)];
        const r1 = computeTiered(table, q1, 'l');
        const r2 = computeTiered(table, q2, 'l');
        fc.pre(r1.bands[0]?.from === r2.bands[0]?.from); // même palier atteint
        expect(r1.exact.lte(r2.exact)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('VOLUME à prix de paliers décroissants : le prix unitaire moyen ne remonte jamais', () => {
    fc.assert(
      fc.property(tierTable('VOLUME', true), fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 2000 }), (table, a, b) => {
        const [q1, q2] = a <= b ? [a, b] : [b, a];
        const u1 = computeTiered(table, D(q1), 'l').exact.div(q1);
        const u2 = computeTiered(table, D(q2), 'l').exact.div(q2);
        expect(u2.lte(u1)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('propriété — non-régression des arrondis', () => {
  test('toCents : entier, écart ≤ 0,5 centime, symétrique', () => {
    fc.assert(
      fc.property(decimalStr(1_000_000, 8), fc.boolean(), roundingMode, (s, neg, mode) => {
        const exact = neg ? D(s).neg() : D(s);
        const cents = toCents(exact, mode);
        expect(typeof cents).toBe('bigint');
        expect(D(cents.toString()).minus(exact.times(100)).abs().lte(D('0.5'))).toBe(true);
        expect(toCents(exact.neg(), mode)).toBe(-cents);
      }),
      { numRuns: 1000 },
    );
  });

  test('priceAt : chaque total de ligne est à ≤ 0,5 centime du produit exact prix unitaire × quantité', () => {
    fc.assert(
      fc.property(decimalStr(10_000, 6), decimalStr(1000, 6), roundingMode, (unitPrice, qty, rounding) => {
        const r = priceAt(
          {
            schedules: [
              {
                id: 's',
                validFrom: '2026-01-01',
                validTo: null,
                currency: 'EUR',
                lines: [{ id: 'l', code: 'L', label: 'l', unit: 'u', kind: 'UNIT', mode: 'MANUAL', vatRatePercent: '20', unitPrice, quantity: { source: 'FIXED', value: qty } }],
              },
            ],
            settings: { rounding },
          },
          '2026-06-01',
        );
        const l = r.lines[0];
        expect(typeof l?.totalHtCents).toBe('bigint');
        const exactCents = D(unitPrice).times(qty).times(100);
        expect(D(String(l?.totalHtCents)).minus(exactCents).abs().lte(D('0.5'))).toBe(true);
        // La TVA de chaque taux est elle aussi à ≤ 0,5 centime de la valeur exacte.
        for (const v of r.totals.vatByRate) {
          const exactVat = D(v.baseHtCents.toString()).times(v.ratePercent).div(100);
          expect(D(v.vatCents.toString()).minus(exactVat).abs().lte(D('0.5'))).toBe(true);
        }
        expect(r.totals.ttcCents).toBe(r.totals.htCents + r.totals.vatCents);
      }),
      { numRuns: 300 },
    );
  });
});

// Générateur de barèmes réalistes pour l'idempotence.
const regularLine = (i: number): fc.Arbitrary<PricingLine> =>
  fc.oneof(
    fc.record({
      kind: fc.constantFrom('UNIT' as const, 'FLAT_MONTHLY' as const, 'FLAT_YEARLY' as const, 'SETUP_FEE' as const, 'HOURLY' as const),
      unitPrice: decimalStr(5000, 6),
      qty: decimalStr(200, 2),
      vat: fc.constantFrom('0', '5.5', '10', '20'),
    }).map(({ kind, unitPrice, qty, vat }): PricingLine => ({
      id: `l${i}`,
      code: `A${i}`,
      label: `Ligne ${i}`,
      unit: 'u',
      kind,
      mode: 'MANUAL',
      vatRatePercent: vat,
      unitPrice,
      quantity: { source: 'FIXED', value: qty },
    })),
    fc.record({ table: tierTable('GRADUATED'), qty: fc.integer({ min: 0, max: 3000 }) }).map(
      ({ table, qty }): PricingLine => ({
        id: `l${i}`,
        code: `A${i}`,
        label: `Paliers ${i}`,
        unit: 'poste',
        kind: 'TIERED',
        mode: 'MANUAL',
        vatRatePercent: '20',
        tiers: table,
        quantity: { source: 'FIXED', value: String(qty) },
      }),
    ),
  );

const pricingInput: fc.Arbitrary<PricingInput> = fc
  .integer({ min: 1, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => regularLine(i))))
  .map((lines) => ({
    schedules: [{ id: 's', validFrom: '2026-01-01', validTo: null, currency: 'EUR' as const, lines }],
    overrides: [
      { id: 'o', lineId: 'l0', unitPrice: '1', validFrom: '2026-03-01', validTo: '2026-03-31', reason: 'test', authorId: 'a', approvedBy: 'b' },
    ],
  }));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('propriété — idempotence et pureté de priceAt', () => {
  test('même entrée → même sortie (égalité profonde) ; entrée gelée jamais modifiée', () => {
    fc.assert(
      fc.property(pricingInput, fc.constantFrom('2026-02-15', '2026-03-15'), (input, date) => {
        const before = JSON.stringify(input);
        const frozen = deepFreeze(structuredClone(input));
        const r1 = priceAt(frozen, date); // lèverait TypeError en cas de mutation (mode strict)
        const r2 = priceAt(frozen, date);
        const r3 = priceAt(structuredClone(input), date);
        expect(r2).toEqual(r1);
        expect(r3).toEqual(r1);
        expect(JSON.stringify(input)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe('propriété — révision P1 = P0 × (a + b × S1 / S0)', () => {
  const idx = (s0: string, s1: string) => [
    {
      code: 'I',
      name: 'I',
      values: [
        { period: '2025-01', value: s0, publishedAt: '2025-01-31' },
        { period: '2026-01', value: s1, publishedAt: '2026-01-31' },
      ],
    },
  ];
  const spec = (a: string, b: string) => ({ indexCode: 'I', a, b, referenceDate: '2025-02-01', revisionDate: '2026-02-01' });
  const positive = decimalStr(10_000, 4).filter((s) => !D(s).isZero());

  test('a = 1, b = 0 → P1 = P0, quelles que soient les valeurs d’indice', () => {
    fc.assert(
      fc.property(decimalStr(100_000, 6), positive, positive, (p0, s0, s1) => {
        expect(computeRevision(D(p0), spec('1', '0'), idx(s0, s1), 'LATEST_PUBLISHED').exact.eq(D(p0))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('S1 = S0 → P1 = P0, quels que soient a et b (a + b = 1)', () => {
    fc.assert(
      fc.property(decimalStr(100_000, 6), positive, fc.integer({ min: 0, max: 100 }), (p0, s, aPct) => {
        const a = D(aPct).div(100).toString();
        const b = D(100 - aPct).div(100).toString();
        expect(computeRevision(D(p0), spec(a, b), idx(s, s), 'LATEST_PUBLISHED').exact.eq(D(p0))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('indice en hausse → prix non décroissant (a, b ≥ 0)', () => {
    fc.assert(
      fc.property(decimalStr(100_000, 6), positive, positive, fc.integer({ min: 0, max: 100 }), (p0, x, y, aPct) => {
        const [s0, s1] = D(x).lte(D(y)) ? [x, y] : [y, x];
        const a = D(aPct).div(100).toString();
        const b = D(100 - aPct).div(100).toString();
        expect(computeRevision(D(p0), spec(a, b), idx(s0, s1), 'LATEST_PUBLISHED').exact.gte(D(p0))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
