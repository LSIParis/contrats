import { describe, test, expect } from 'vitest';
import { FakeQuantityProvider, resolveQuantities, priceAt, PricingError, type QuantityProvider } from '../src/index.js';
import { input, line } from './fixtures.js';

const fake = () =>
  new FakeQuantityProvider([
    { contractRef: 'C-1', articleCode: 'POSTE', effectiveFrom: '2026-01-01', quantity: '40', observedAt: '2026-01-01T02:00:00Z' },
    { contractRef: 'C-1', articleCode: 'POSTE', effectiveFrom: '2026-02-01', quantity: '42', observedAt: '2026-02-01T02:00:00Z' },
    { contractRef: 'C-1', articleCode: 'SRV', effectiveFrom: '2026-01-01', quantity: '3' },
    { contractRef: 'C-2', articleCode: 'POSTE', effectiveFrom: '2026-01-01', quantity: '7' },
  ]);

describe('FakeQuantityProvider', () => {
  test('renvoie la dernière observation en vigueur à la date', async () => {
    const p = fake();
    await expect(p.getQuantity('C-1', 'POSTE', '2026-01-31')).resolves.toEqual({
      quantity: '40',
      source: 'fake',
      observedAt: '2026-01-01T02:00:00Z',
    });
    await expect(p.getQuantity('C-1', 'POSTE', '2026-03-01')).resolves.toMatchObject({ quantity: '42' });
    await expect(p.getQuantity('C-2', 'POSTE', '2026-03-01')).resolves.toMatchObject({ quantity: '7', observedAt: null });
  });

  test('aucune observation → QUANTITY_UNAVAILABLE (pas de zéro implicite)', async () => {
    await expect(fake().getQuantity('C-1', 'POSTE', '2025-12-31')).rejects.toMatchObject({ code: 'QUANTITY_UNAVAILABLE' });
    await expect(fake().getQuantity('C-9', 'POSTE', '2026-01-31')).rejects.toBeInstanceOf(PricingError);
  });

  test('journalise les appels (pour les tests d’intégration)', async () => {
    const p = fake();
    await p.getQuantity('C-1', 'SRV', '2026-01-15');
    expect(p.calls).toEqual([{ contractRef: 'C-1', articleCode: 'SRV', date: '2026-01-15' }]);
  });
});

describe('resolveQuantities — étape asynchrone AVANT priceAt', () => {
  const lines = [
    line({ id: 'postes', code: 'POSTE', unitPrice: '35', quantity: { source: 'PROVIDER' } }),
    line({ id: 'serveurs', code: 'SERVEUR', unitPrice: '90', quantity: { source: 'PROVIDER', articleCode: 'SRV' } }),
    line({ id: 'forfait', kind: 'FLAT_MONTHLY', unitPrice: '100' }),
  ];

  test('n’interroge que les lignes PROVIDER, avec le code article du fournisseur', async () => {
    const p = fake();
    const q = await resolveQuantities(input(lines), 'C-1', '2026-02-15', p);
    expect(q).toEqual([
      { lineId: 'postes', quantity: '42', source: 'fake', observedAt: '2026-02-01T02:00:00Z' },
      { lineId: 'serveurs', quantity: '3', source: 'fake', observedAt: null },
    ]);
    expect(p.calls.map((c) => c.articleCode)).toEqual(['POSTE', 'SRV']);

    const r = priceAt(input(lines, { quantities: q }), '2026-02-15');
    expect(r.totals.htCents).toBe(42n * 3500n + 3n * 9000n + 10000n);
  });

  test('erreur du fournisseur → rattachée à la ligne', async () => {
    await expect(resolveQuantities(input(lines), 'C-9', '2026-02-15', fake())).rejects.toMatchObject({
      code: 'QUANTITY_UNAVAILABLE',
      details: { lineId: 'postes' },
    });
  });

  test('quantité invalide renvoyée par un fournisseur → INVALID_DECIMAL', async () => {
    const broken: QuantityProvider = { getQuantity: () => Promise.resolve({ quantity: '4,5', source: 'x', observedAt: null }) };
    await expect(resolveQuantities(input(lines), 'C-1', '2026-02-15', broken)).rejects.toMatchObject({ code: 'INVALID_DECIMAL' });
  });
});
