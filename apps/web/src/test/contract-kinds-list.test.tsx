import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractKindsPage } from '../features/contract-kinds/contract-kinds-page.js';
import { mockApi, problem, renderWithClient } from './api-mock.js';
import { kindRoutes } from './contract-kinds-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

test('liste : types prédéfinis signalés, préfixe figé, suppression réservée aux types vides', async () => {
  mockApi(kindRoutes);
  renderWithClient(<ContractKindsPage />);
  const table = await screen.findByRole('table', { name: 'Types de contrats' });
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(within(rows[1]!).getByText('Microsoft 365')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('prédéfini')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('préfixe figé')).toBeInTheDocument();
  expect(within(rows[2]!).queryByText('prédéfini')).not.toBeInTheDocument();
  expect(within(table).getByRole('link', { name: 'Ouvrir Microsoft 365' })).toHaveAttribute('href', '/contract-kinds/k1');
  expect(within(table).queryByRole('button', { name: 'Supprimer Microsoft 365' })).not.toBeInTheDocument();
  expect(within(table).getByRole('button', { name: 'Supprimer Audit' })).toBeInTheDocument();
});

test('création : préfixe mis en majuscules, conflit PREFIX_TAKEN affiché', async () => {
  const user = userEvent.setup();
  const calls = mockApi([
    ['POST', '/v1/contract-kinds', () => problem(409, 'Le préfixe SEC est déjà utilisé par un autre type de contrat.', { code: 'PREFIX_TAKEN' })],
    ...kindRoutes,
  ]);
  renderWithClient(<ContractKindsPage />);
  await user.click(await screen.findByRole('button', { name: 'Nouveau type' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouveau type de contrat' });
  await user.type(within(dialog).getByLabelText('Libellé'), 'Sécurité');
  await user.type(within(dialog).getByLabelText('Préfixe'), 'sec');
  expect(within(dialog).getByLabelText('Préfixe')).toHaveValue('SEC');
  await user.type(within(dialog).getByLabelText('Ordre d’affichage'), '30');
  await user.click(within(dialog).getByRole('button', { name: 'Créer le type' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Le préfixe SEC est déjà utilisé');
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ label: 'Sécurité', prefix: 'SEC', sortOrder: 30 });
});

test('archivage confirmé d’un type', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/contract-kinds/k2/archive', () => ({ archivedAt: '2026-10-15T00:00:00Z' })], ...kindRoutes]);
  renderWithClient(<ContractKindsPage />);
  const table = await screen.findByRole('table', { name: 'Types de contrats' });
  await user.click(within(table).getByRole('button', { name: 'Archiver Audit' }));
  const confirm = await screen.findByRole('dialog', { name: 'Archiver le type Audit' });
  await user.click(within(confirm).getByRole('button', { name: 'Archiver' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/contract-kinds/k2/archive')).toBe(true));
});

test('durées : explication, création d’une durée', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/commitment-terms', (b) => ({ id: 't36', archivedAt: null, ...(b as object) })], ...kindRoutes]);
  renderWithClient(<ContractKindsPage />);
  await user.click(await screen.findByRole('tab', { name: 'Durées d’engagement' }));
  const table = await screen.findByRole('table', { name: 'Durées d’engagement' });
  expect(within(table).getByText('E00')).toBeInTheDocument();
  expect(screen.getByText(/0 mois = sans engagement/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Nouvelle durée' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle durée d’engagement' });
  await user.type(within(dialog).getByLabelText('Nombre de mois'), '36');
  await user.type(within(dialog).getByLabelText('Libellé'), '36 mois');
  await user.click(within(dialog).getByRole('button', { name: 'Créer la durée' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ months: 36, label: '36 mois' });
});

test('lecteur : aucune action de gestion', async () => {
  const user = userEvent.setup();
  mockApi(kindRoutes, { userId: 'u-r', roles: ['READER'] });
  renderWithClient(<ContractKindsPage />);
  const table = await screen.findByRole('table', { name: 'Types de contrats' });
  expect(within(table).getByRole('link', { name: 'Ouvrir Microsoft 365' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nouveau type' })).not.toBeInTheDocument();
  expect(within(table).queryAllByRole('button')).toHaveLength(0);
  await user.click(screen.getByRole('tab', { name: 'Durées d’engagement' }));
  await screen.findByRole('table', { name: 'Durées d’engagement' });
  expect(screen.queryByRole('button', { name: 'Nouvelle durée' })).not.toBeInTheDocument();
});
