import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PricingCatalogPage } from '../features/pricing/pricing-catalog-page.js';
import { draftFromGrid, linesToSwitch, switchVariantCode } from '../features/pricing/grid-lines.js';
import { emptyDraft } from '../features/pricing/line-draft.js';
import type { VariantSnapshot } from '../features/contract-kinds/types.js';
import { json, mockApi, renderWithClient } from './api-mock.js';
import { detail, mountWorkspace } from './proposal-fixtures.js';

/** Codes de la grille tarifaire dans les documents (13-types-contrats.md §7). */

afterEach(() => vi.unstubAllGlobals());

const TERMS = { items: [{ id: 't0', months: 0, label: 'Sans engagement', archivedAt: null }, { id: 't12', months: 12, label: '12 mois', archivedAt: null }, { id: 't36', months: 36, label: '36 mois', archivedAt: null }] };
const V12: VariantSnapshot = {
  code: 'M365-0003-E12', itemCode: 'M365-0003', months: 12, termLabel: '12 mois', label: 'Business Standard', description: null,
  unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20', unitPrice: '11.7', purchasePrice: null, effectiveFrom: '2026-01-01', on: '2026-10-15',
  kind: { id: 'k1', prefix: 'M365', label: 'Microsoft 365' },
};

function withGridLine() {
  const d = detail();
  d.version.pricingDefinition.lines.push({
    key: 'm365-0003', label: 'Business Standard', kind: 'REQUIRED', unit: 'par utilisateur', recurrence: 'MONTHLY', group: 'RECURRING',
    quantity: { default: 1, min: 0, editableByClient: false }, pricing: { dependsOn: 'engagement', byChoice: { 12: 1170, 36: 1050 } },
    priceStatus: 'VALIDATED', grid: { itemCode: 'M365-0003', variants: { 12: 'M365-0003-E12', 36: 'M365-0003-E36' }, vatRatePercent: '20', on: '2026-10-15' },
  });
  return d;
}

async function openPricing() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Tarification' }));
  return { user, panel: await screen.findByRole('region', { name: 'Tableau de prix' }) };
}

describe('proposition', () => {
  test('ajout depuis la grille : filtrée sur la durée en cours, le serveur copie la ligne', async () => {
    const api = mountWorkspace({
      routes: {
        'GET /v1/commitment-terms': TERMS,
        'GET /v1/contract-kinds': { items: [] },
        'GET /v1/price-grid/variants': { on: '2026-10-15', items: [V12] },
        'POST /v1/proposals/p-1/pricing/grid-lines': withGridLine(),
      },
    });
    const { user, panel } = await openPricing();
    await user.click(within(panel).getByRole('button', { name: 'Ajouter depuis la grille' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter une ligne depuis la grille tarifaire' });
    const row = await within(dialog).findByRole('row', { name: /M365-0003-E12/ });
    expect(api.find('GET', '/v1/price-grid/variants')[0]!.url).toContain('months=12');
    await user.click(within(row).getByRole('button', { name: 'Choisir' }));
    await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/pricing/grid-lines')[0]?.body).toEqual({ itemCode: 'M365-0003' }));
  });

  test('durées : ajouter « sans engagement » avec lignes de grille → confirmation, puis bascule', async () => {
    const d = withGridLine();
    const api = mountWorkspace({ detail: d, routes: { 'GET /v1/commitment-terms': TERMS, 'PUT /v1/proposals/p-1/pricing/commitments': d } });
    const { user, panel } = await openPricing();
    const durations = within(panel).getByRole('group', { name: /Durées proposées/ });
    await user.click(await within(durations).findByRole('checkbox', { name: 'Sans engagement' }));
    await user.click(within(panel).getByRole('button', { name: 'Appliquer les durées' }));
    const dialog = await screen.findByRole('dialog', { name: 'Basculer les lignes de la grille ?' });
    expect(dialog).toHaveTextContent('M365-0003');
    await user.click(within(dialog).getByRole('button', { name: 'Basculer vers les versions' }));
    await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/pricing/commitments')[0]?.body).toEqual({ months: [0, 12, 36], defaultMonths: 12, switchGridLines: true }));
  });

  test('durées sans ligne de grille : appliquées directement, sans bascule', async () => {
    const api = mountWorkspace({ routes: { 'GET /v1/commitment-terms': TERMS, 'PUT /v1/proposals/p-1/pricing/commitments': detail() } });
    const { user, panel } = await openPricing();
    const durations = within(panel).getByRole('group', { name: /Durées proposées/ });
    await user.click(await within(durations).findByRole('checkbox', { name: '36 mois' }));
    await user.click(within(panel).getByRole('button', { name: 'Appliquer les durées' }));
    await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/pricing/commitments')[0]?.body).toEqual({ months: [12], defaultMonths: 12, switchGridLines: false }));
  });
});

describe('barème de contrat', () => {
  test('ligne copiée de la grille : code de version, prix et TVA, type du moteur', () => {
    const d = draftFromGrid(V12, 3);
    expect(d).toMatchObject({ lineKey: 'm365-0003-e12', articleCode: 'M365-0003-E12', label: 'Business Standard', unit: 'par utilisateur', kind: 'UNIT', recurrence: 'MONTHLY', mode: 'MANUAL', unitPrice: '11,7', vatRatePercent: '20' });
    expect(draftFromGrid({ ...V12, unit: 'FLAT', recurrence: 'YEARLY' }, 1)).toMatchObject({ kind: 'FLAT_YEARLY', recurrence: '' });
    expect(draftFromGrid({ ...V12, recurrence: 'ONE_OFF' }, 1)).toMatchObject({ kind: 'SETUP_FEE' });
  });

  test('bascule de durée : lignes de grille d’une autre durée détectées, codes recalculés', () => {
    const drafts = [draftFromGrid(V12, 1), { ...emptyDraft(2), articleCode: 'INFOG' }, draftFromGrid({ ...V12, code: 'M365-0004-E36' }, 3)];
    expect(linesToSwitch(drafts, 36)).toEqual([0]);
    expect(linesToSwitch(drafts, 0)).toEqual([0, 2]);
    expect(switchVariantCode('M365-0003-E12', 0)).toBe('M365-0003-E00');
    expect(switchVariantCode('INFOG', 12)).toBeNull();
  });
});

describe('devis', () => {
  test('code choisi dans la grille, résultat « Grille tarifaire »', async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      ['GET', '/v1/price-indexes', () => ({ items: [] })],
      ['GET', /^\/v1\/pricing-rules(\?.*)?$/, () => ({ items: [] })],
      ['GET', '/v1/customers', () => ({ items: [] })],
      ['GET', /^\/v1\/contract-kinds\?/, () => ({ items: [] })],
      ['GET', /^\/v1\/commitment-terms\?/, () => TERMS],
      ['GET', /^\/v1\/price-grid\/variants/, () => ({ on: '2026-10-15', items: [V12] })],
      ['POST', '/v1/pricing/quote', () => json({
        source: 'GRID', articleCode: 'M365-0003-E12', gridItemCode: 'M365-0003', commitmentMonths: 12, priceEffectiveFrom: '2026-01-01',
        quantity: '10', date: '2026-10-15',
        line: { lineId: 'quote', code: 'M365-0003-E12', label: 'Business Standard', unit: 'par utilisateur', kind: 'UNIT', mode: 'MANUAL', recurrence: 'MONTHLY', quantity: '10', unitPrice: '11.700000', vatRatePercent: '20', totalHtCents: '11700' },
        totals: { htCents: '11700', vatCents: '2340', ttcCents: '14040', vatByRate: [], monthlyRecurringCents: '11700', annualRecurringCents: '140400' },
      })],
    ], { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
    renderWithClient(<PricingCatalogPage />);
    await user.click(await screen.findByRole('tab', { name: 'Devis' }));
    const region = await screen.findByRole('region', { name: 'Devis rapide' });
    await user.click(within(region).getByRole('button', { name: 'Grille' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choisir un code de la grille tarifaire' });
    await user.click(within(await within(dialog).findByRole('row', { name: /M365-0003-E12/ })).getByRole('button', { name: 'Choisir' }));
    expect(within(region).getByLabelText('Code article')).toHaveValue('M365-0003-E12');
    await user.type(within(region).getByLabelText('Quantité'), '10');
    await user.click(within(region).getByRole('button', { name: 'Calculer le prix' }));
    expect(await within(region).findByText(/Grille tarifaire — M365-0003, engagement 12 mois/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/pricing/quote')!.body).toEqual({ articleCode: 'M365-0003-E12', quantity: '10' });
  });
});
