import { describe, test, expect } from 'vitest';
import {
  D,
  lookupIndexValue,
  computeRevision,
  revisionCoefficient,
  assertRevisionCoefficients,
  PricingError,
  type PriceIndex,
} from '../src/index.js';

const SYNTEC: PriceIndex = {
  code: 'SYNTEC',
  name: 'Indice Syntec',
  values: [
    { period: '2025-06', value: '318.9', publishedAt: '2025-07-28' },
    { period: '2025-07', value: '321.5', publishedAt: '2025-08-27' },
    { period: '2025-08', value: '322.0', publishedAt: '2025-09-29' },
    { period: '2026-07', value: '333.2', publishedAt: '2026-08-26' },
  ],
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as PricingError).code;
  }
  return undefined;
};

describe('lookupIndexValue', () => {
  test('LATEST_PUBLISHED : dernière période ≤ date ET publiée à cette date', () => {
    // Le 2025-09-15, la valeur d'août n'est pas encore publiée (29/09) : on retient juillet.
    const o = lookupIndexValue([SYNTEC], 'SYNTEC', '2025-09-15', 'LATEST_PUBLISHED');
    expect(o).toEqual({
      indexCode: 'SYNTEC',
      indexName: 'Indice Syntec',
      requestedDate: '2025-09-15',
      rule: 'LATEST_PUBLISHED',
      period: '2025-07',
      value: '321.5',
      publishedAt: '2025-08-27',
    });
    expect(lookupIndexValue([SYNTEC], 'SYNTEC', '2025-09-30', 'LATEST_PUBLISHED').period).toBe('2025-08');
  });

  test('LATEST_PUBLISHED : une période future publiée n’est jamais retenue', () => {
    const idx: PriceIndex = { ...SYNTEC, values: [{ period: '2025-10', value: '1', publishedAt: '2025-01-01' }] };
    expect(codeOf(() => lookupIndexValue([idx], 'SYNTEC', '2025-09-15', 'LATEST_PUBLISHED'))).toBe('INDEX_VALUE_NOT_FOUND');
  });

  test('EXACT_PERIOD : la période du mois de la date, indépendamment de la publication', () => {
    expect(lookupIndexValue([SYNTEC], 'SYNTEC', '2025-08-01', 'EXACT_PERIOD')).toMatchObject({ period: '2025-08', value: '322.0' });
    expect(codeOf(() => lookupIndexValue([SYNTEC], 'SYNTEC', '2025-09-30', 'EXACT_PERIOD'))).toBe('INDEX_VALUE_NOT_FOUND');
  });

  test('aucune valeur antérieure → INDEX_VALUE_NOT_FOUND (jamais de valeur devinée)', () => {
    expect(codeOf(() => lookupIndexValue([SYNTEC], 'SYNTEC', '2020-01-01', 'LATEST_PUBLISHED'))).toBe('INDEX_VALUE_NOT_FOUND');
  });

  test('indice inconnu → INDEX_NOT_FOUND', () => {
    expect(codeOf(() => lookupIndexValue([SYNTEC], 'INSEE', '2025-09-15', 'LATEST_PUBLISHED'))).toBe('INDEX_NOT_FOUND');
  });

  test('période en double → DUPLICATE_INDEX_VALUE', () => {
    const dup: PriceIndex = { ...SYNTEC, values: [...SYNTEC.values, { period: '2025-07', value: '999', publishedAt: '2025-08-01' }] };
    expect(codeOf(() => lookupIndexValue([dup], 'SYNTEC', '2025-09-15', 'LATEST_PUBLISHED'))).toBe('DUPLICATE_INDEX_VALUE');
  });

  test('ordre des valeurs sans effet', () => {
    const shuffled: PriceIndex = { ...SYNTEC, values: [...SYNTEC.values].reverse() };
    expect(lookupIndexValue([shuffled], 'SYNTEC', '2025-09-15', 'LATEST_PUBLISHED').period).toBe('2025-07');
  });
});

describe('assertRevisionCoefficients', () => {
  test('a + b = 1 exactement', () => {
    expect(() => assertRevisionCoefficients(D('0.15'), D('0.85'))).not.toThrow();
    expect(() => assertRevisionCoefficients(D('1'), D('0'))).not.toThrow();
    expect(codeOf(() => assertRevisionCoefficients(D('0.15'), D('0.84')))).toBe('INVALID_REVISION_COEFFICIENTS');
    expect(codeOf(() => assertRevisionCoefficients(D('0.1500001'), D('0.85')))).toBe('INVALID_REVISION_COEFFICIENTS');
    expect(codeOf(() => assertRevisionCoefficients(D('-0.2'), D('1.2')))).toBe('INVALID_REVISION_COEFFICIENTS');
  });
});

describe('revisionCoefficient', () => {
  test('S0 = 0 → DIVISION_BY_ZERO', () => {
    expect(codeOf(() => revisionCoefficient(D('0.15'), D('0.85'), D('0'), D('1')))).toBe('DIVISION_BY_ZERO');
  });
});

describe('computeRevision — exemple chiffré documenté (04-tarification.md §6.3)', () => {
  test('Syntec S0=321.5, S1=333.2, a=0.15, b=0.85, P0=1250.00', () => {
    const r = computeRevision(
      D('1250.00'),
      { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-01' },
      [SYNTEC],
      'LATEST_PUBLISHED',
    );
    expect(r.S0).toMatchObject({ period: '2025-07', value: '321.5' });
    expect(r.S1).toMatchObject({ period: '2026-07', value: '333.2' });
    // Étapes, telles qu'écrites dans la documentation (40 chiffres significatifs) :
    expect(r.ratio.toString()).toBe('1.036391912908242612752721617418351477449');
    expect(r.coefficient.toString()).toBe('1.030933125972006220839813374805598755832');
    expect(r.exact.toString()).toBe('1288.66640746500777604976671850699844479');
    expect(r.exact.toDecimalPlaces(6).toFixed(6)).toBe('1288.666407');
    expect(r.exact.toDecimalPlaces(2).toFixed(2)).toBe('1288.67');
  });
});
