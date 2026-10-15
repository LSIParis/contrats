import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ContractKindDetailPage } from '../features/contract-kinds/contract-kind-detail-page.js';
import { todayIso } from '../features/contract-kinds/labels.js';
import { json, mockApi, problem, renderWithClient } from './api-mock.js';
import { kindRoutes } from './contract-kinds-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const renderDetail = () =>
  renderWithClient(
    <Routes><Route path="/contract-kinds/:id" element={<ContractKindDetailPage />} /></Routes>,
    ['/contract-kinds/k1'],
  );

test('grille : une colonne par durée, « — » si non proposée, prix d’achat et prix programmé', async () => {
  const calls = mockApi(kindRoutes);
  renderDetail();
  const table = await screen.findByRole('table', { name: 'Grille tarifaire Microsoft 365' });
  const head = within(table).getAllByRole('columnheader').map((h) => h.textContent);
  expect(head).toEqual(expect.arrayContaining(['Sans engagement', '12 mois', '24 mois']));
  const row = within(table).getAllByRole('row')[1]!;
  const cells = within(row).getAllByRole('cell');
  expect(cells[0]).toHaveTextContent('M365-0001');
  expect(cells[2]).toHaveTextContent('par utilisateur');
  expect(cells[3]).toHaveTextContent('mensuelle');
  expect(cells[4]).toHaveTextContent('20 %');
  expect(cells[5]).toHaveTextContent('15,00 €');
  expect(cells[6]).toHaveTextContent('12,50 €');
  expect(cells[6]).toHaveTextContent('achat 10,00 €');
  expect(cells[6]).toHaveTextContent('→ 13,00 € au 01/01/2027');
  expect(cells[7]).toHaveTextContent(/^—$/);
  expect(screen.getByRole('link', { name: 'Exporter CSV' })).toHaveAttribute('href', '/v1/contract-kinds/k1/grid.csv');
  expect(calls.some((c) => c.url === `/v1/contract-kinds/k1/grid?on=${todayIso()}&archived=false`)).toBe(true);
});

test('prix : seules les durées modifiées sont envoyées, null pour une durée retirée', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/price-grid/items/M365-0001/prices', () => ({})], ...kindRoutes]);
  renderDetail();
  await user.click(await screen.findByRole('button', { name: 'Modifier les prix de M365-0001' }));
  const dialog = await screen.findByRole('dialog', { name: 'Modifier les prix de M365-0001' });
  expect(within(dialog).getByLabelText('Prix de vente — 12 mois')).toHaveValue('12,5');
  expect(within(dialog).getByLabelText('Prix d’achat — 12 mois')).toHaveValue('10');
  await user.clear(within(dialog).getByLabelText('Prix de vente — Sans engagement'));
  await user.clear(within(dialog).getByLabelText('Prix de vente — 12 mois'));
  await user.type(within(dialog).getByLabelText('Prix de vente — 12 mois'), '12,9');
  await user.click(within(dialog).getByRole('button', { name: 'Enregistrer les prix' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
    effectiveFrom: todayIso(),
    prices: [{ months: 0, unitPrice: null }, { months: 12, unitPrice: '12.9', purchasePrice: '10' }],
  });
});

test('nouveau code : prix par durée, durées vides non proposées', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/contract-kinds/k1/grid/items', () => ({ code: 'M365-0002' })], ...kindRoutes]);
  renderDetail();
  await user.click(await screen.findByRole('button', { name: 'Nouveau code' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouveau code — Microsoft 365' });
  await user.type(within(dialog).getByLabelText('Libellé'), 'Exchange Online');
  await user.selectOptions(within(dialog).getByLabelText('Unité'), 'par licence');
  await user.type(within(dialog).getByLabelText('Prix de vente — 12 mois'), '4,2');
  await user.type(within(dialog).getByLabelText('Prix d’achat — 12 mois'), '3');
  await user.click(within(dialog).getByRole('button', { name: 'Créer le code' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
    label: 'Exchange Online', unit: 'PER_LICENSE', recurrence: 'MONTHLY', vatRatePercent: '20', effectiveFrom: todayIso(),
    prices: [{ months: 12, unitPrice: '4.2', purchasePrice: '3' }],
  });
});

test('import CSV : erreurs par ligne, puis aperçu (dryRun) et confirmation', async () => {
  const user = userEvent.setup();
  let n = 0;
  const calls = mockApi([
    ['POST', '/v1/contract-kinds/k1/grid/import', (b) => {
      n += 1;
      if (n === 1) return problem(422, 'Fichier refusé : 1 ligne(s) invalide(s).', { code: 'CSV_INVALID', errors: [{ line: 3, message: 'unité inconnue « mois »' }] });
      const dryRun = (b as FormData).get('dryRun') === 'true';
      return json({ dryRun, effectiveFrom: '2026-11-01', created: ['(nouveau)'], updated: ['M365-0001'], pricesAdded: 4, variantsWithdrawn: 1 });
    }],
    ...kindRoutes,
  ]);
  renderDetail();
  await user.click(await screen.findByRole('button', { name: 'Importer CSV' }));
  const dialog = await screen.findByRole('dialog', { name: 'Importer la grille — Microsoft 365' });
  expect(within(dialog).getByText(/code;libelle;description;unite;periodicite;tva;E00;E12;E24;achat_E00/)).toBeInTheDocument();
  const file = new File(['code;libelle\n'], 'grille.csv', { type: 'text/csv' });
  await user.upload(within(dialog).getByLabelText('Fichier CSV'), file);
  const eff = within(dialog).getByLabelText('Date d’effet des prix');
  await user.clear(eff);
  await user.type(eff, '2026-11-01');
  await user.click(within(dialog).getByRole('button', { name: 'Analyser le fichier' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Ligne 3 : unité inconnue « mois »');

  await user.click(within(dialog).getByRole('button', { name: 'Analyser le fichier' }));
  const status = await within(dialog).findByRole('status');
  expect(status).toHaveTextContent('1 code(s) créé(s), 1 mis à jour, 4 prix ajouté(s), 1 durée(s) retirée(s)');
  const dry = calls.filter((c) => c.method === 'POST')[1]!.body as FormData;
  expect(dry.get('dryRun')).toBe('true');
  expect(dry.get('effectiveFrom')).toBe('2026-11-01');
  expect(dry.get('file')).toBeInstanceOf(File);

  await user.click(within(dialog).getByRole('button', { name: 'Confirmer l’import' }));
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3));
  expect((calls.filter((c) => c.method === 'POST')[2]!.body as FormData).get('dryRun')).toBe('false');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('historique : prix d’un code par durée, du plus récent au plus ancien', async () => {
  const user = userEvent.setup();
  mockApi([
    ['GET', '/v1/price-grid/items/M365-0001/history', () => ({
      code: 'M365-0001', label: 'Business Standard',
      variants: [{
        code: 'M365-0001-E12', months: 12, archivedAt: null,
        prices: [
          { id: 'p1', effectiveFrom: '2026-01-01', unitPrice: '12.5', purchasePrice: '10', enteredByUserId: null, createdAt: '2025-12-15T10:00:00Z' },
          { id: 'p2', effectiveFrom: '2027-01-01', unitPrice: '13', purchasePrice: null, enteredByUserId: null, createdAt: '2026-10-01T10:00:00Z' },
        ],
      }],
    })],
    ...kindRoutes,
  ]);
  renderDetail();
  await user.click(await screen.findByRole('tab', { name: 'Historique' }));
  await user.selectOptions(await screen.findByLabelText('Code'), 'M365-0001 — Business Standard');
  const table = await screen.findByRole('table', { name: 'Historique M365-0001-E12' });
  const rows = within(table).getAllByRole('row');
  expect(rows[1]).toHaveTextContent('01/01/2027');
  expect(rows[1]).toHaveTextContent('13,00 €');
  expect(rows[2]).toHaveTextContent('12,50 €');
  expect(rows[2]).toHaveTextContent('10,00 €');
});

test('contenu contractuel : rattachement d’un modèle ; paramètres : préfixe figé', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['PUT', '/v1/contract-kinds/k1', (b) => ({ id: 'k1', ...(b as object) })], ...kindRoutes]);
  renderDetail();
  await user.click(await screen.findByRole('tab', { name: 'Contenu contractuel' }));
  expect(screen.getByText('Aucun contenu contractuel rattaché pour l’instant.')).toBeInTheDocument();
  await user.selectOptions(await screen.findByLabelText('Modèle de contrat'), 'Contrat M365');
  await user.click(screen.getByRole('button', { name: 'Rattacher le modèle' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ contractTemplateId: 'tpl1' });

  await user.click(screen.getByRole('tab', { name: 'Paramètres' }));
  expect(screen.getByLabelText('Préfixe')).toBeDisabled();
  expect(screen.getByText(/Figé : des codes tarifs ont été créés/)).toBeInTheDocument();
});

test('lecteur : grille en lecture seule, aucune action', async () => {
  const user = userEvent.setup();
  mockApi(kindRoutes, { userId: 'u-r', roles: ['READER'] });
  renderDetail();
  const table = await screen.findByRole('table', { name: 'Grille tarifaire Microsoft 365' });
  expect(within(table).queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Nouveau code' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Importer CSV' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Exporter CSV' })).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Contenu contractuel' }));
  expect(screen.queryByLabelText('Modèle de contrat')).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Paramètres' }));
  expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Libellé')).toBeDisabled();
});
