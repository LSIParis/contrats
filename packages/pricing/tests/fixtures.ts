import type { PriceIndex, PricingInput, PricingLine, PricingSchedule } from '../src/index.js';

/** Série Syntec FICTIVE pour les tests (valeurs arrondies, non officielles). */
export const SYNTEC: PriceIndex = {
  code: 'SYNTEC',
  name: 'Indice Syntec (valeurs de test)',
  values: [
    { period: '2025-07', value: '321.5', publishedAt: '2025-08-27' },
    { period: '2026-07', value: '333.2', publishedAt: '2026-08-26' },
  ],
};

export const line = (p: Partial<PricingLine> & Pick<PricingLine, 'id'>): PricingLine => ({
  code: p.id.toUpperCase(),
  label: `Ligne ${p.id}`,
  unit: 'unité',
  kind: 'UNIT',
  mode: 'MANUAL',
  vatRatePercent: '20',
  ...p,
});

export const schedule = (lines: PricingLine[], p: Partial<PricingSchedule> = {}): PricingSchedule => ({
  id: 's1',
  validFrom: '2025-01-01',
  validTo: null,
  currency: 'EUR',
  lines,
  ...p,
});

export const input = (lines: PricingLine[], p: Partial<PricingInput> = {}): PricingInput => ({
  schedules: [schedule(lines)],
  indexes: [SYNTEC],
  ...p,
});
