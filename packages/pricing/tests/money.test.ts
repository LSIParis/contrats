import { describe, test, expect } from 'vitest';
import {
  D,
  toCents,
  roundToScale,
  parseDecimal,
  centsToEuros,
  formatCents,
  parseIsoDate,
  PricingError,
} from '../src/index.js';

describe('toCents — arrondi au centime', () => {
  test('demi à l’écart de zéro (défaut) : x.xx5 monte', () => {
    expect(toCents(D('1.005'))).toBe(101n);
    expect(toCents(D('2.675'))).toBe(268n); // piège classique du binaire flottant
    expect(toCents(D('0.125'))).toBe(13n);
    expect(toCents(D('10.004999'))).toBe(1000n);
  });

  test('demi à l’écart de zéro sur un négatif : -x.xx5 descend (symétrique)', () => {
    expect(toCents(D('-1.005'))).toBe(-101n);
    expect(toCents(D('-0.125'))).toBe(-13n);
    expect(toCents(D('-0.124'))).toBe(-12n);
  });

  test('demi au pair (HALF_EVEN) : vers le chiffre pair', () => {
    expect(toCents(D('0.125'), 'HALF_EVEN')).toBe(12n);
    expect(toCents(D('0.135'), 'HALF_EVEN')).toBe(14n);
    expect(toCents(D('-0.125'), 'HALF_EVEN')).toBe(-12n);
    expect(toCents(D('0.1251'), 'HALF_EVEN')).toBe(13n);
  });

  test('un montant déjà au centime est inchangé', () => {
    expect(toCents(D('1288.67'))).toBe(128867n);
    expect(toCents(D('0'))).toBe(0n);
  });

  test('grands montants : aucune perte de précision (bigint)', () => {
    expect(toCents(D('123456789012345.675'))).toBe(12345678901234568n);
  });
});

describe('roundToScale', () => {
  test('arrondit à n décimales selon le mode', () => {
    expect(roundToScale(D('1288.666407465007776'), 6).toFixed(6)).toBe('1288.666407');
    expect(roundToScale(D('0.0000005'), 6).toFixed(6)).toBe('0.000001');
    expect(roundToScale(D('0.0000005'), 6, 'HALF_EVEN').toFixed(6)).toBe('0.000000');
  });
});

describe('parseDecimal', () => {
  test('accepte les décimaux au point, jusqu’à 6 décimales par défaut', () => {
    expect(parseDecimal('12.5', 'prix').toString()).toBe('12.5');
    expect(parseDecimal('0.012500', 'prix').toFixed(4)).toBe('0.0125');
  });
  test('refuse virgule, exposant, espaces, vide, trop de décimales', () => {
    for (const bad of ['12,5', '1e3', ' 1', '', '1.1234567', 'NaN', 'Infinity', '.5', '1.']) {
      expect(() => parseDecimal(bad, 'prix')).toThrow(PricingError);
    }
  });
  test('refuse un négatif sauf autorisation explicite', () => {
    expect(() => parseDecimal('-1', 'prix')).toThrow(/prix/);
    expect(parseDecimal('-1', 'x', { allowNegative: true }).toString()).toBe('-1');
  });
  test('maxScale paramétrable', () => {
    expect(parseDecimal('321.12345678', 'indice', { maxScale: 10 }).toString()).toBe('321.12345678');
  });
});

describe('centimes ↔ euros', () => {
  test('centsToEuros et formatCents', () => {
    expect(centsToEuros(128867n).toFixed(2)).toBe('1288.67');
    expect(formatCents(-5n)).toBe('-0.05');
    expect(formatCents(100n)).toBe('1.00');
  });
});

describe('parseIsoDate', () => {
  test('accepte YYYY-MM-DD valides seulement', () => {
    expect(parseIsoDate('2026-02-28', 'date')).toBe('2026-02-28');
    for (const bad of ['2026-02-30', '2026-2-1', '2026-13-01', '26-01-01', '2026-01-01T00:00:00Z']) {
      expect(() => parseIsoDate(bad, 'date')).toThrow(PricingError);
    }
  });
});
