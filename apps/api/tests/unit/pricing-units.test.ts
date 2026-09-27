import { describe, test, expect } from 'vitest';
import { CsvIndexConnector } from '../../src/pricing/index-connector.js';
import { nextAnniversary } from '../../src/pricing/pricing.service.js';
import { pricingStatus } from '../../src/pricing/pricing-errors.js';

/** Briques pures de la couche tarification (aucune base, aucun réseau). */
describe('CsvIndexConnector', () => {
  const csv = new CsvIndexConnector();
  const parse = (text: string, config: Record<string, unknown> | null = null) => csv.parse(Buffer.from(text, 'utf8'), config);

  test('en-tête, BOM, commentaires et lignes vides ignorés ; date de publication facultative', () => {
    const r = parse('﻿period;value;publishedAt\r\n# x\r\n2025-07;321.5;2025-08-27\r\n\r\n2026-07;333.2\r\n');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 3, period: '2025-07', value: '321.5', publishedAt: '2025-08-27' },
      { line: 5, period: '2026-07', value: '333.2', publishedAt: null },
    ]);
  });

  test('virgule décimale seulement si paramétrée, et jamais avec le séparateur virgule', () => {
    expect(parse('2025-07;321,5').errors).toHaveLength(1);
    expect(parse('2025-07;321,5', { decimalComma: true }).rows[0]?.value).toBe('321.5');
    expect(parse('2025-07,321.5', { delimiter: ',' }).rows[0]?.value).toBe('321.5');
  });

  test('toutes les erreurs collectées, numérotées : période, valeur, date, doublon, colonnes', () => {
    const r = parse('2025-00;1\n2025-01;-3\n2025-02;1;2025-02-30\n2025-03;1;2025-02-01\n2025-04;1\n2025-04;2\n2025-05\n2025-06;0');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(r.rows.map((x) => x.period)).toEqual(['2025-04']);
  });
});

describe('nextAnniversary (V2-H24)', () => {
  test('anniversaire suivant, borné par « from » et strictement après « after »', () => {
    expect(nextAnniversary('2026-09-01', '2026-09-27')).toBe('2027-09-01');
    expect(nextAnniversary('2024-09-01', '2026-09-01')).toBe('2026-09-01');
    expect(nextAnniversary('2026-09-01', '2026-01-01', '2027-09-01')).toBe('2028-09-01');
    expect(nextAnniversary('2024-02-29', '2025-01-01')).toBe('2025-02-28');
  });
});

describe('traduction des erreurs du moteur', () => {
  test('404 sans barème, 409 données manquantes, 422 barème incohérent', () => {
    expect(pricingStatus('NO_SCHEDULE')).toBe(404);
    expect(pricingStatus('INDEX_VALUE_NOT_FOUND')).toBe(409);
    expect(pricingStatus('QUANTITY_UNAVAILABLE')).toBe(409);
    expect(pricingStatus('FORMULA_SYNTAX')).toBe(422);
    expect(pricingStatus('INVALID_LINE')).toBe(422);
  });
});
