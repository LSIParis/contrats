import type { Route } from './api-mock.js';

/** Données de test des écrans « Types de contrats » (forme de l'API contract-kinds). */
export const KIND_M365 = {
  id: 'k1', prefix: 'M365', label: 'Microsoft 365', description: 'Licences et support M365', sortOrder: 10,
  isSystem: true, systemKey: 'M365', contractTemplateId: null, prefixLocked: true, itemCount: 1, archivedAt: null,
};
export const KIND_AUDIT = {
  id: 'k2', prefix: 'AUD', label: 'Audit', description: null, sortOrder: 20,
  isSystem: false, systemKey: null, contractTemplateId: null, prefixLocked: false, itemCount: 0, archivedAt: null,
};
export const TERMS = [
  { id: 't0', months: 0, label: 'Sans engagement', archivedAt: null },
  { id: 't12', months: 12, label: '12 mois', archivedAt: null },
  { id: 't24', months: 24, label: '24 mois', archivedAt: null },
];
export const ITEM = {
  id: 'i1', code: 'M365-0001', number: 1, label: 'Business Standard', description: null, unit: 'PER_USER', recurrence: 'MONTHLY',
  vatRatePercent: '20', sortOrder: 0, archivedAt: null,
  variants: [
    { code: 'M365-0001-E00', months: 0, archivedAt: null, unitPrice: '15', purchasePrice: null, effectiveFrom: '2026-01-01', upcoming: null },
    {
      code: 'M365-0001-E12', months: 12, archivedAt: null, unitPrice: '12.5', purchasePrice: '10', effectiveFrom: '2026-01-01',
      upcoming: { effectiveFrom: '2027-01-01', unitPrice: '13', purchasePrice: null },
    },
  ],
};
export const GRID = { on: '2026-10-15', kind: KIND_M365, terms: TERMS, items: [ITEM] };

export const kindRoutes: Route[] = [
  ['GET', /^\/v1\/contract-kinds\?archived=(true|false)$/, () => ({ items: [KIND_M365, KIND_AUDIT] })],
  ['GET', '/v1/contract-kinds/k1', () => KIND_M365],
  ['GET', /^\/v1\/contract-kinds\/k1\/grid\?/, () => GRID],
  ['GET', /^\/v1\/commitment-terms\?archived=(true|false)$/, () => ({ items: TERMS })],
  ['GET', '/v1/templates', () => ({ items: [{ id: 'tpl1', name: 'Contrat M365', slug: 'm365', category: 'MSP', status: 'PUBLISHED' }] })],
];
