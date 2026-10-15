import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ContractKindDetailPage } from '../features/contract-kinds/contract-kind-detail-page.js';
import { todayIso } from '../features/contract-kinds/labels.js';
import { PricingTable } from '../features/proposals/public/pricing-table.js';
import { emptyHtml, HtmlField } from '../features/structure/html-field.js';
import { mockApi, renderWithClient } from './api-mock.js';
import { GRID, ITEM, kindRoutes } from './contract-kinds-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

function Harness({ initial = '', maxLength }: { initial?: string; maxLength?: number }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <HtmlField label="Description" value={v} onChange={setV} {...(maxLength !== undefined ? { maxLength } : {})} />
      <output data-testid="valeur">{v}</output>
    </>
  );
}

test('emptyHtml : éditeur vide et blancs → chaîne vide', () => {
  expect(emptyHtml('<p></p>')).toBe('');
  expect(emptyHtml('  ')).toBe('');
  expect(emptyHtml(null)).toBe('');
  expect(emptyHtml('<p><br></p>')).toBe('');
  expect(emptyHtml(' <p>x</p> ')).toBe('<p>x</p>');
});

test('HtmlField : mode « HTML source » modifie le HTML brut ; compteur et dépassement', async () => {
  const user = userEvent.setup();
  render(<Harness initial="<p>Bonjour</p>" maxLength={30} />);
  expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
  expect(screen.getByText('14 / 30')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'HTML source' }));
  const source = screen.getByRole('textbox', { name: 'Description (HTML source)' });
  expect(source).toHaveValue('<p>Bonjour</p>');
  await user.clear(source);
  await user.type(source, '<h3>Titre</h3>');
  expect(screen.getByTestId('valeur')).toHaveTextContent('<h3>Titre</h3>');
  expect(screen.getByText('14 / 30')).not.toHaveClass('text-danger');
  await user.type(source, '<p>Un texte bien trop long</p>');
  expect(screen.getByText(/\/ 30 — trop long/)).toHaveClass('text-danger');
  await user.click(screen.getByRole('button', { name: 'Texte mis en forme' }));
  expect(screen.queryByRole('textbox', { name: 'Description (HTML source)' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
});

const renderDetail = () =>
  renderWithClient(
    <Routes><Route path="/contract-kinds/:id" element={<ContractKindDetailPage />} /></Routes>,
    ['/contract-kinds/k1'],
  );

test('grille : la description HTML s’affiche sur sa propre ligne, en pleine largeur', async () => {
  const item = { ...ITEM, description: '<p><strong>Inclus</strong> : support 5j/7</p>' };
  mockApi([['GET', /^\/v1\/contract-kinds\/k1\/grid\?/, () => ({ ...GRID, items: [item] })], ...kindRoutes]);
  renderDetail();
  const table = await screen.findByRole('table', { name: 'Grille tarifaire Microsoft 365' });
  const row = within(table).getByRole('row', { name: 'Description de M365-0001' });
  const cell = within(row).getByRole('cell');
  expect(cell).toHaveAttribute('colspan', String(5 + GRID.terms.length + 1));
  expect(within(cell).getByText('Inclus').tagName).toBe('STRONG');
});

test('nouveau code : la description HTML (mode source) est envoyée', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/contract-kinds/k1/grid/items', () => ({ code: 'M365-0002' })], ...kindRoutes]);
  renderDetail();
  await user.click(await screen.findByRole('button', { name: 'Nouveau code' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouveau code — Microsoft 365' });
  await user.type(within(dialog).getByLabelText('Libellé'), 'Exchange Online');
  await user.click(within(dialog).getByRole('button', { name: 'HTML source' }));
  await user.type(within(dialog).getByRole('textbox', { name: 'Description (HTML source)' }), '<ul><li>Boîte 50 Go</li></ul>');
  await user.click(within(dialog).getByRole('button', { name: 'Créer le code' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
    label: 'Exchange Online', description: '<ul><li>Boîte 50 Go</li></ul>', unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20', effectiveFrom: todayIso(),
  });
});

test('modifier un code : description vidée → null', async () => {
  const user = userEvent.setup();
  const item = { ...ITEM, description: '<p>Ancienne</p>' };
  const calls = mockApi([
    ['PUT', '/v1/price-grid/items/M365-0001', () => item],
    ['GET', /^\/v1\/contract-kinds\/k1\/grid\?/, () => ({ ...GRID, items: [item] })],
    ...kindRoutes,
  ]);
  renderDetail();
  await user.click(await screen.findByRole('button', { name: 'Modifier M365-0001' }));
  const dialog = await screen.findByRole('dialog', { name: 'Modifier M365-0001' });
  await user.click(within(dialog).getByRole('button', { name: 'HTML source' }));
  await user.clear(within(dialog).getByRole('textbox', { name: 'Description (HTML source)' }));
  await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ description: null });
});

test('page client : la description HTML d’une ligne s’affiche sous la ligne du devis', () => {
  const bucket = { htCents: 0, vatCents: 0, ttcCents: 0 };
  render(
    <PricingTable
      editable={false}
      onChange={async () => {}}
      pricing={{
        definition: {
          vatRatePercent: 20,
          choices: [],
          lines: [{
            key: 'poste', label: 'Poste de travail', description: '<p>Supervision <em>24/7</em></p>', kind: 'REQUIRED', unit: 'poste / mois',
            recurrence: 'MONTHLY', group: 'RECURRING', priceFrom: false, pricing: {}, quantity: null,
          }],
        } as never,
        selection: { choices: {}, quantities: {}, selectedOptions: [] },
        quote: {
          choices: {}, quantities: { poste: 2 }, selectedOptions: [], commitmentMonths: 12,
          lines: [{ key: 'poste', label: 'Poste de travail', group: 'RECURRING', recurrence: 'MONTHLY', unit: 'poste / mois', quantity: 2, unitPriceCents: 2500, totalHtCents: 5000, priceStatus: 'VALIDATED', priceFrom: false }],
          infoLines: [],
          totals: { oneTime: bucket, monthly: bucket, quarterly: bucket, yearly: bucket, commitment: bucket },
          errors: [], blockingValidations: [],
        } as never,
      }}
    />,
  );
  const row = screen.getByRole('row', { name: 'Description de Poste de travail' });
  expect(within(row).getByRole('cell')).toHaveAttribute('colspan', '5');
  expect(within(row).getByText('24/7').tagName).toBe('EM');
});
