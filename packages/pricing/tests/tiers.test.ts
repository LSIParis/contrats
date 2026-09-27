import { describe, test, expect } from 'vitest';
import { D, computeTiered, PricingError, type TierTable } from '../src/index.js';

// 1–10 : 30 €, 11–50 : 25 €, 51+ : 20 €
const tiers = (mode: 'GRADUATED' | 'VOLUME'): TierTable => ({
  mode,
  tiers: [
    { upTo: '10', unitPrice: '30' },
    { upTo: '50', unitPrice: '25' },
    { upTo: null, unitPrice: '20' },
  ],
});

describe('computeTiered — GRADUATED (chaque tranche à son prix)', () => {
  test.each([
    ['0', '0'],
    ['5', '150'],
    ['10', '300'],
    ['11', '325'],
    ['50', '1300'], // 300 + 40×25
    ['60', '1500'], // 1300 + 10×20
  ])('q=%s → %s €', (q, total) => {
    expect(computeTiered(tiers('GRADUATED'), D(q), 'l').exact.toString()).toBe(total);
  });

  test('la trace détaille chaque tranche consommée', () => {
    const r = computeTiered(tiers('GRADUATED'), D('12'), 'l');
    expect(r.bands).toEqual([
      { from: '0', to: '10', quantity: '10', unitPrice: '30', amount: '300' },
      { from: '10', to: '50', quantity: '2', unitPrice: '25', amount: '50' },
    ]);
  });

  test('quantités fractionnaires', () => {
    expect(computeTiered(tiers('GRADUATED'), D('10.5'), 'l').exact.toString()).toBe('312.5');
  });
});

describe('computeTiered — VOLUME (toute la quantité au prix du palier atteint)', () => {
  test.each([
    ['0', '0'],
    ['10', '300'],
    ['11', '275'], // 11×25 : franchir le palier fait BAISSER le total (effet de seuil documenté)
    ['50', '1250'],
    ['51', '1020'],
  ])('q=%s → %s €', (q, total) => {
    expect(computeTiered(tiers('VOLUME'), D(q), 'l').exact.toString()).toBe(total);
  });

  test('trace : un seul palier, toute la quantité', () => {
    expect(computeTiered(tiers('VOLUME'), D('11'), 'l').bands).toEqual([
      { from: '10', to: '50', quantity: '11', unitPrice: '25', amount: '275' },
    ]);
  });
});

describe('validation des paliers', () => {
  const bad = (t: TierTable, q = '1') => {
    try {
      computeTiered(t, D(q), 'ligne-x');
    } catch (e) {
      return (e as PricingError).code;
    }
    return undefined;
  };
  test('bornes strictement croissantes, illimité seulement en dernier, table non vide', () => {
    expect(bad({ mode: 'GRADUATED', tiers: [] })).toBe('INVALID_LINE');
    expect(bad({ mode: 'GRADUATED', tiers: [{ upTo: '10', unitPrice: '1' }, { upTo: '10', unitPrice: '1' }] })).toBe('INVALID_LINE');
    expect(bad({ mode: 'GRADUATED', tiers: [{ upTo: null, unitPrice: '1' }, { upTo: '10', unitPrice: '1' }] })).toBe('INVALID_LINE');
    expect(bad({ mode: 'GRADUATED', tiers: [{ upTo: '0', unitPrice: '1' }] })).toBe('INVALID_LINE');
    expect(bad({ mode: 'GRADUATED', tiers: [{ upTo: '10', unitPrice: '-1' }] })).toBe('INVALID_DECIMAL');
  });
  test('quantité au-delà du dernier palier borné → INVALID_LINE', () => {
    expect(bad({ mode: 'VOLUME', tiers: [{ upTo: '10', unitPrice: '1' }] }, '11')).toBe('INVALID_LINE');
    expect(bad({ mode: 'GRADUATED', tiers: [{ upTo: '10', unitPrice: '1' }] }, '11')).toBe('INVALID_LINE');
  });
});
