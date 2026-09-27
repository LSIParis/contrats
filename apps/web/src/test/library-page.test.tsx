import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LibraryPage } from '../features/library/library-page.js';
import { filterLibrary, type LibraryItem } from '../features/library/library-api.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

const ITEMS: LibraryItem[] = [
  { id: 'i1', code: 'CONF', category: 'CONFIDENTIALITE', title: 'Confidentialité', isDemo: true,
    currentVersion: { id: 'v2', versionNumber: 2, bodyHtml: '<p>Les parties gardent le secret des données échangées.</p>', variables: [], changeNote: null, createdAt: '2026-02-01' } },
  { id: 'i2', code: 'RESP', category: 'RESPONSABILITE', title: 'Responsabilité', isDemo: false,
    currentVersion: { id: 'v9', versionNumber: 1, bodyHtml: '<p>Plafond égal à douze mois de redevance.</p>', variables: [], changeNote: null, createdAt: '2026-02-01' } },
];
const ME = (permissions: string[]) => ({ userId: 'u', fullName: 'X', email: 'x@lsi.fr', kind: 'INTERNAL', roles: [], customerId: null, permissions });

test('filterLibrary cherche dans le code, le titre et le texte, sans accents', () => {
  expect(filterLibrary(ITEMS, 'donnees').map((i) => i.code)).toEqual(['CONF']);
  expect(filterLibrary(ITEMS, 'resp').map((i) => i.code)).toEqual(['RESP']);
  expect(filterLibrary(ITEMS, '', 'CONFIDENTIALITE').map((i) => i.code)).toEqual(['CONF']);
});

test('liste, recherche et historique des versions (lecture seule pour un commercial)', async () => {
  routeFetch({
    'GET /v1/auth/me': ME(['contracts.write']),
    'GET /v1/clauses': { items: ITEMS },
    'GET /v1/clauses/i1': { id: 'i1', code: 'CONF', category: 'CONFIDENTIALITE', title: 'Confidentialité', isDemo: true, archivedAt: null, currentVersionId: 'v2',
      versions: [
        { id: 'v2', versionNumber: 2, bodyHtml: '<p>Texte v2</p>', variables: ['client.raisonSociale'], changeNote: 'Durée portée à 5 ans', createdAt: '2026-02-01' },
        { id: 'v1', versionNumber: 1, bodyHtml: '<p>Texte v1</p>', variables: [], changeNote: null, createdAt: '2026-01-01' },
      ] },
  });
  wrap(<LibraryPage />);
  expect(await screen.findByRole('button', { name: 'Responsabilité' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Rechercher une clause'), 'secret');
  expect(screen.queryByRole('button', { name: 'Responsabilité' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nouvelle clause' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Confidentialité' }));
  const panel = await screen.findByRole('dialog', { name: 'Confidentialité (CONF)' });
  expect(await within(panel).findByText(/Version 2 — .* \(courante\) — Durée portée à 5 ans/)).toBeInTheDocument();
  expect(within(panel).getByText(/Version 1/)).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: 'Nouvelle version' })).not.toBeInTheDocument();
});

test('le juriste crée une clause', async () => {
  const api = routeFetch({
    'GET /v1/auth/me': ME(['clauses.manage']),
    'GET /v1/clauses': { items: ITEMS },
    'POST /v1/clauses': { id: 'i3', versionId: 'v3' },
  });
  wrap(<LibraryPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Nouvelle clause' }));
  const dialog = screen.getByRole('dialog', { name: 'Nouvelle clause' });
  await userEvent.type(within(dialog).getByLabelText('Code'), 'force-majeure');
  await userEvent.selectOptions(within(dialog).getByLabelText('Catégorie'), 'DIVERS');
  await userEvent.type(within(dialog).getByLabelText('Titre'), 'Force majeure');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Créer la clause' }));
  await waitFor(() => expect(api.find('POST', '/v1/clauses')).toHaveLength(1));
  expect(api.find('POST', '/v1/clauses')[0]!.body).toMatchObject({ code: 'FORCE-MAJEURE', category: 'DIVERS', title: 'Force majeure' });
});

test('conflit de code : message serveur affiché', async () => {
  routeFetch({
    'GET /v1/auth/me': ME(['clauses.manage']),
    'GET /v1/clauses': { items: ITEMS },
    'POST /v1/clauses': [409, { code: 'CLAUSE_CODE_DUP', detail: 'Le code CONF existe déjà.' }],
  });
  wrap(<LibraryPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Nouvelle clause' }));
  const dialog = screen.getByRole('dialog', { name: 'Nouvelle clause' });
  await userEvent.type(within(dialog).getByLabelText('Code'), 'CONF');
  await userEvent.type(within(dialog).getByLabelText('Titre'), 'Doublon');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Créer la clause' }));
  expect(await within(dialog).findByText('Le code CONF existe déjà.')).toBeInTheDocument();
});
