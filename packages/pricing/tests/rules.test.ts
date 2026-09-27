import { describe, test, expect } from 'vitest';
import { D, findRule, gridUnitPrice, adjustmentFor, PricingError, type RuleCatalog, type PricingRule } from '../src/index.js';

const catalog: RuleCatalog = {
  rules: [
    { id: 'grid', type: 'GRID', entries: [{ articleCode: 'POSTE', unitPrice: '35' }] },
    {
      id: 'vol',
      type: 'VOLUME_DISCOUNT',
      thresholds: [
        { minQuantity: '50', percent: '10' },
        { minQuantity: '20', percent: '5' },
      ],
    },
    {
      id: 'engagement',
      type: 'COMMITMENT_DISCOUNT',
      thresholds: [
        { minMonths: 12, percent: '3' },
        { minMonths: 36, percent: '8' },
      ],
    },
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

describe('catalogue de règles', () => {
  test('findRule / gridUnitPrice', () => {
    const g = findRule(catalog, 'grid', 'l1') as Extract<PricingRule, { type: 'GRID' }>;
    expect(gridUnitPrice(g, 'POSTE', 'l1').toString()).toBe('35');
    expect(codeOf(() => gridUnitPrice(g, 'SERVEUR', 'l1'))).toBe('RULE_NOT_FOUND');
    expect(codeOf(() => findRule(catalog, 'nope', 'l1'))).toBe('RULE_NOT_FOUND');
    expect(codeOf(() => findRule(undefined, 'grid', 'l1'))).toBe('RULE_NOT_FOUND');
  });

  test('remise volume : seuil le plus élevé atteint, ordre des seuils indifférent', () => {
    const vol = findRule(catalog, 'vol', 'l1');
    expect(adjustmentFor(vol, D('19'), undefined, 'l1')).toMatchObject({ threshold: null, basis: '19' });
    expect(adjustmentFor(vol, D('19'), undefined, 'l1').percent.toString()).toBe('0');
    expect(adjustmentFor(vol, D('20'), undefined, 'l1').percent.toString()).toBe('5');
    expect(adjustmentFor(vol, D('75'), undefined, 'l1')).toMatchObject({ threshold: '50' });
  });

  test('remise d’engagement : exige la durée d’engagement', () => {
    const eng = findRule(catalog, 'engagement', 'l1');
    expect(codeOf(() => adjustmentFor(eng, D('1'), {}, 'l1'))).toBe('MISSING_CONTEXT');
    expect(adjustmentFor(eng, D('1'), { commitmentMonths: 36 }, 'l1').percent.toString()).toBe('8');
    expect(adjustmentFor(eng, D('1'), { commitmentMonths: 24 }, 'l1').percent.toString()).toBe('3');
    expect(adjustmentFor(eng, D('1'), { commitmentMonths: 6 }, 'l1').threshold).toBeNull();
  });

  test('une règle de prix n’est pas un ajustement', () => {
    expect(codeOf(() => adjustmentFor(findRule(catalog, 'grid', 'l1'), D('1'), undefined, 'l1'))).toBe('INVALID_LINE');
  });
});
