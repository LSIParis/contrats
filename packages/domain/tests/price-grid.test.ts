import { describe, expect, test } from 'vitest';
import {
  commitmentSuffix,
  formatGridItemCode,
  formatGridVariantCode,
  gridPriceToCents,
  isValidContractKindPrefix,
  parseGridCode,
  priceInEffect,
  switchVariantCode,
} from '../src/index.js';

describe('grille tarifaire — codes', () => {
  test('préfixe : 2 à 6 caractères, majuscules et chiffres', () => {
    expect(['HM', 'MNT', 'M365', 'RSSI', 'ABCDEF'].every(isValidContractKindPrefix)).toBe(true);
    expect(['M', 'm365', 'ABCDEFG', 'M-3', 'É1', ''].some(isValidContractKindPrefix)).toBe(false);
  });

  test('codes de base et de version', () => {
    expect(formatGridItemCode('M365', 3)).toBe('M365-0003');
    expect(formatGridItemCode('HM', 12345)).toBe('HM-12345');
    expect(formatGridVariantCode('M365-0003', 0)).toBe('M365-0003-E00');
    expect(formatGridVariantCode('M365-0003', 36)).toBe('M365-0003-E36');
    expect(() => formatGridItemCode('m', 1)).toThrow(/Préfixe/);
    expect(() => formatGridItemCode('MNT', 0)).toThrow(/Numéro/);
    expect(() => commitmentSuffix(100)).toThrow(/0 à 99/);
    expect(() => commitmentSuffix(1.5)).toThrow();
  });

  test('analyse et bascule de durée', () => {
    expect(parseGridCode('M365-0003-E24')).toEqual({ prefix: 'M365', number: 3, itemCode: 'M365-0003', months: 24 });
    expect(parseGridCode('MNT-0001')).toEqual({ prefix: 'MNT', number: 1, itemCode: 'MNT-0001' });
    expect(parseGridCode('MNT-0000')).toBeNull();
    expect(parseGridCode('INFOG')).toBeNull();
    expect(switchVariantCode('M365-0003-E12', 36)).toBe('M365-0003-E36');
    expect(switchVariantCode('M365-0003', 0)).toBe('M365-0003-E00');
    expect(switchVariantCode('libre', 12)).toBeNull();
  });
});

describe('grille tarifaire — prix', () => {
  const prices = [
    { id: '01', effectiveFrom: '2026-01-01', v: 10 },
    { id: '02', effectiveFrom: '2026-07-01', v: 12 },
    { id: '03', effectiveFrom: '2026-07-01', v: 11 }, // correction le jour même
    { id: '04', effectiveFrom: '2027-01-01', v: 13 }, // future
  ];

  test('prix en vigueur : plus grande date d\'effet, puis dernière saisie', () => {
    expect(priceInEffect(prices, '2025-12-31')).toBeNull();
    expect(priceInEffect(prices, '2026-03-15')?.v).toBe(10);
    expect(priceInEffect(prices, '2026-07-01')?.v).toBe(11);
    expect(priceInEffect(prices, '2027-06-01')?.v).toBe(13);
  });

  test('conversion en centimes pour les propositions', () => {
    expect(gridPriceToCents('12.5')).toBe(1250);
    expect(gridPriceToCents('4.990000')).toBe(499);
    expect(gridPriceToCents('100')).toBe(10000);
    expect(() => gridPriceToCents('4.125')).toThrow(/2 décimales/);
    expect(() => gridPriceToCents('-1')).toThrow(/invalide/);
  });
});
