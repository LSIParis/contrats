import { describe, test, expect } from 'vitest';
import { simulate, toJsonSafe, priceAt, PricingError } from '../src/index.js';
import { input, line } from './fixtures.js';

const revised = line({
  id: 'infog',
  kind: 'FLAT_MONTHLY',
  unitPrice: '1250.00',
  revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-01' },
});
const postes = line({ id: 'postes', unitPrice: '35', quantity: { source: 'FIXED', value: '10' } });

describe('simulate — impact avant application', () => {
  test('révision : valeur d’indice hypothétique pour la période à venir', () => {
    const base = input([revised, postes], {
      indexes: [{ code: 'SYNTEC', name: 'Syntec', values: [{ period: '2025-07', value: '321.5', publishedAt: '2025-08-27' }] }],
    });
    // Sans la valeur 2026-07, LATEST_PUBLISHED retient 2025-07 pour S1 aussi : S1 = S0, prix inchangé.
    expect(priceAt(base, '2026-09-15').totals.htCents).toBe(125000n + 35000n);
    const s = simulate(base, '2026-09-15', { indexValues: [{ indexCode: 'SYNTEC', period: '2026-07', value: '333.2' }] }, { beforeDate: '2026-08-31' });
    expect(s.before.date).toBe('2026-08-31');
    expect(s.before.lines.find((l) => l.lineId === 'infog')?.totalHtCents).toBe(125000n);
    expect(s.after.lines.find((l) => l.lineId === 'infog')?.totalHtCents).toBe(128867n);
    expect(s.lineDeltas).toEqual([
      { lineId: 'infog', label: 'Ligne infog', beforeCents: 125000n, afterCents: 128867n, deltaCents: 3867n, deltaPercent: '3.09' },
      { lineId: 'postes', label: 'Ligne postes', beforeCents: 35000n, afterCents: 35000n, deltaCents: 0n, deltaPercent: '0.00' },
    ]);
    expect(s.totalsDelta).toEqual({ htCents: 3867n, vatCents: 773n, ttcCents: 4640n, monthlyRecurringCents: 3867n, annualRecurringCents: 46404n });
  });

  test('changement de quantité : provenance « simulation » dans la trace', () => {
    const s = simulate(input([postes]), '2026-01-15', { quantities: [{ lineId: 'postes', quantity: '12' }] });
    expect(s.lineDeltas[0]).toMatchObject({ beforeCents: 35000n, afterCents: 42000n, deltaCents: 7000n, deltaPercent: '20.00' });
    expect(s.after.lines[0]?.trace[0]).toEqual({ type: 'QUANTITY', source: 'simulation', quantity: '12', observedAt: null });
  });

  test('changement de prix de base (la révision continue de s’appliquer)', () => {
    const s = simulate(input([revised]), '2026-09-15', { linePrices: [{ lineId: 'infog', unitPrice: '1300' }] });
    // 1300 × 1,030933125972… = 1340,213063… → 1340,21
    expect(s.after.lines[0]?.totalHtCents).toBe(134021n);
  });

  test('ligne inconnue → INVALID_LINE ; prix sur ligne en paliers → INVALID_LINE', () => {
    expect(() => simulate(input([postes]), '2026-01-15', { quantities: [{ lineId: 'zz', quantity: '1' }] })).toThrow(PricingError);
    const tiered = line({ id: 't', kind: 'TIERED', tiers: { mode: 'VOLUME', tiers: [{ upTo: null, unitPrice: '1' }] } });
    expect(() => simulate(input([tiered]), '2026-01-15', { linePrices: [{ lineId: 't', unitPrice: '2' }] })).toThrow(/paliers/);
  });

  test('n’altère pas l’entrée', () => {
    const i = input([postes]);
    const snapshot = JSON.stringify(i);
    simulate(i, '2026-01-15', { quantities: [{ lineId: 'postes', quantity: '99' }], linePrices: [{ lineId: 'postes', unitPrice: '1' }] });
    expect(JSON.stringify(i)).toBe(snapshot);
  });
});

describe('toJsonSafe — sérialisation des centimes bigint', () => {
  test('convertit récursivement les bigint en chaînes', () => {
    const r = priceAt(input([postes]), '2026-01-15');
    const j = toJsonSafe(r);
    expect(j.totals.htCents).toBe('35000');
    expect(j.lines[0]?.totalHtCents).toBe('35000');
    expect(() => JSON.stringify(j)).not.toThrow();
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });
});
