import { describe, test, expect } from 'vitest';
import {
  D,
  overrideGapPercent,
  requiresSecondApproval,
  validateOverride,
  selectOverride,
  PricingError,
  type PriceOverride,
} from '../src/index.js';

const ov = (p: Partial<PriceOverride> = {}): PriceOverride => ({
  id: 'o1',
  lineId: 'l1',
  unitPrice: '95',
  validFrom: '2026-01-01',
  validTo: '2026-03-31',
  reason: 'Geste commercial suite incident',
  authorId: 'alice',
  approvedBy: null,
  ...p,
});

describe('écart et seuil de double validation', () => {
  test('écart en % par rapport au prix calculé', () => {
    expect(overrideGapPercent(D('95'), D('100'))?.toString()).toBe('5');
    expect(overrideGapPercent(D('120'), D('100'))?.toString()).toBe('20');
    expect(overrideGapPercent(D('0'), D('0'))?.toString()).toBe('0');
    expect(overrideGapPercent(D('1'), D('0'))).toBeNull(); // écart infini
  });
  test('double validation strictement au-delà du seuil', () => {
    expect(requiresSecondApproval(D('90'), D('100'), D('10'))).toBe(false);
    expect(requiresSecondApproval(D('89.99'), D('100'), D('10'))).toBe(true);
    expect(requiresSecondApproval(D('1'), D('0'), D('10'))).toBe(true);
  });
});

describe('validateOverride (contrôle à l’écriture)', () => {
  test('dérogation conforme', () => {
    expect(validateOverride(ov())).toEqual([]);
  });
  test('motif vide, période inversée, auto-validation, prix invalide', () => {
    expect(validateOverride(ov({ reason: '   ' })).map((i) => i.code)).toEqual(['EMPTY_REASON']);
    expect(validateOverride(ov({ validFrom: '2026-04-01' })).map((i) => i.code)).toEqual(['INVALID_PERIOD']);
    expect(validateOverride(ov({ approvedBy: 'alice' })).map((i) => i.code)).toEqual(['SELF_APPROVAL']);
    expect(validateOverride(ov({ unitPrice: '12,5' })).map((i) => i.code)).toEqual(['INVALID_PRICE']);
  });
});

describe('selectOverride (à la date du calcul)', () => {
  const t = D('10');

  test('hors période : ignorée sans bruit', () => {
    const r = selectOverride([ov()], '2026-04-01', D('100'), t);
    expect(r.applied).toBeNull();
    expect(r.skipped).toEqual([]);
  });

  test('bornes incluses', () => {
    expect(selectOverride([ov()], '2026-01-01', D('100'), t).applied?.override.id).toBe('o1');
    expect(selectOverride([ov()], '2026-03-31', D('100'), t).applied?.override.id).toBe('o1');
  });

  test('sous le seuil : appliquée sans second validateur', () => {
    const r = selectOverride([ov()], '2026-02-01', D('100'), t);
    expect(r.applied).toMatchObject({ requiresSecondApproval: false });
    expect(r.applied?.gapPercent?.toString()).toBe('5');
  });

  test('au-delà du seuil sans validation : ignorée, raison tracée', () => {
    const r = selectOverride([ov({ unitPrice: '50' })], '2026-02-01', D('100'), t);
    expect(r.applied).toBeNull();
    expect(r.skipped).toEqual([{ overrideId: 'o1', reason: 'REQUIRES_SECOND_APPROVAL', gapPercent: '50' }]);
  });

  test('au-delà du seuil, validée par l’auteur lui-même : ignorée (SELF_APPROVAL)', () => {
    const r = selectOverride([ov({ unitPrice: '50', approvedBy: 'alice' })], '2026-02-01', D('100'), t);
    expect(r.skipped[0]?.reason).toBe('SELF_APPROVAL');
  });

  test('au-delà du seuil, validée par un tiers : appliquée', () => {
    const r = selectOverride([ov({ unitPrice: '50', approvedBy: 'bob' })], '2026-02-01', D('100'), t);
    expect(r.applied).toMatchObject({ requiresSecondApproval: true });
  });

  test('motif vide : ignorée (EMPTY_REASON), jamais appliquée', () => {
    const r = selectOverride([ov({ reason: '' })], '2026-02-01', D('100'), t);
    expect(r.applied).toBeNull();
    expect(r.skipped[0]?.reason).toBe('EMPTY_REASON');
  });

  test('plusieurs dérogations valides : la plus récente l’emporte, les autres SUPERSEDED', () => {
    const r = selectOverride(
      [ov({ id: 'old', validFrom: '2026-01-01' }), ov({ id: 'new', validFrom: '2026-02-01', unitPrice: '96' })],
      '2026-02-15',
      D('100'),
      t,
    );
    expect(r.applied?.override.id).toBe('new');
    expect(r.skipped).toEqual([{ overrideId: 'old', reason: 'SUPERSEDED', gapPercent: '5' }]);
  });

  test('deux dérogations valides de même date de début → AMBIGUOUS_OVERRIDE', () => {
    expect(() => selectOverride([ov({ id: 'a' }), ov({ id: 'b' })], '2026-02-15', D('100'), t)).toThrow(PricingError);
  });
});
