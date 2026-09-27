import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ContractDetailPage } from '../features/contracts/contract-detail-page.js';
import { ContractsPage } from '../features/contracts/contracts-page.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function detail(over: Record<string, unknown> = {}) {
  return {
    contract: {
      id: 'k1', reference: 'IMP-2026-0001', title: 'Contrat Dupont', status: 'IMPORTED_PENDING_VALIDATION',
      currentVersionId: null, startDate: null, endDate: null, noticePeriodDays: null, archivedAt: null,
      origin: 'IMPORTED', ...over,
    },
    customer: { id: 'c1', name: 'Dupont SAS' },
    importedDocument: { name: 'dupont.pdf' },
    signatureRequest: null, reminders: [], timeline: [{ at: '2026-09-01T10:00:00Z', type: 'IMPORT', label: 'Import du document' }],
    signers: [], approval: null, renewal: null, predecessor: null, openAmendment: null, amends: null,
  };
}

function setup(body: unknown, initial = '/contracts/k1') {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/v1/auth/me')) return json({ userId: 'u1', roles: ['LEGAL_REVIEWER'] });
    if (url.endsWith('/allowed-actions')) return json({ allowedActions: [] });
    if (url.endsWith('/deadlines')) {
      return json({ items: [{ id: 'd1', contractId: 'k1', customerId: 'c1', kind: 'PERIOD_END', dueDate: '2099-12-31T00:00:00.000Z', details: null, contract: { reference: 'IMP-2026-0001', title: 'x', status: 'ACTIVE' } }] });
    }
    if (url.includes('/comments')) return json({ items: [] });
    if (url.endsWith('/pricing/schedules')) return json({ items: [], nextRevisionDate: null });
    if (url.endsWith('/pricing/overrides')) return json({ items: [] });
    if (url.endsWith('/v1/contracts/k1')) return json(body);
    return new Response('', { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes><Route path="/contracts/:id" element={<ContractDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

test('onglets dans l’ordre du brief, Synthèse active par défaut', async () => {
  setup(detail());
  const tablist = await screen.findByRole('tablist', { name: 'Sections du contrat' });
  expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual([
    'Synthèse', 'Contenu', 'Annexes', 'Tarification', 'Signature', 'Avenants', 'Échéances', 'Documents', 'Historique',
  ]);
  expect(within(tablist).getByRole('tab', { name: 'Synthèse' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: 'Synthèse' })).toBeInTheDocument();
});

test('contrat importé à valider : pastille « Importé », statut, lien « Valider l’import »', async () => {
  setup(detail());
  await screen.findByRole('tablist');
  expect(screen.getAllByText('Importé').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Importé à valider').length).toBeGreaterThan(0);
  expect(screen.getByRole('link', { name: 'Valider l’import' })).toHaveAttribute('href', '/contracts/k1/import');
});

test('Annexes : emplacement explicite ; Tarification : barème du contrat (lot 3)', async () => {
  const user = userEvent.setup();
  setup(detail());
  await user.click(await screen.findByRole('tab', { name: 'Annexes' }));
  expect(screen.getByText('Disponible au lot 2.')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Tarification' }));
  expect(await screen.findByRole('heading', { name: 'Barème — versions' })).toBeInTheDocument();
  expect(await screen.findByText('Aucun barème pour ce contrat.')).toBeInTheDocument();
});

test('navigation clavier entre onglets (flèches)', async () => {
  const user = userEvent.setup();
  setup(detail());
  const first = await screen.findByRole('tab', { name: 'Synthèse' });
  first.focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Contenu' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'Contenu' })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{End}');
  expect(screen.getByRole('tab', { name: 'Historique' })).toHaveFocus();
  expect(screen.getByText(/Import du document/)).toBeInTheDocument(); // chronologie
});

test('?onglet=echeances ouvre les échéances du contrat ; Documents propose l’original', async () => {
  const user = userEvent.setup();
  const urls = setup(detail({ status: 'ACTIVE' }), '/contracts/k1?onglet=echeances');
  expect(await screen.findByText('Fin de période')).toBeInTheDocument();
  expect(urls).toContain('/v1/contracts/k1/deadlines');
  await user.click(screen.getByRole('tab', { name: 'Documents' }));
  expect(screen.getByRole('link', { name: /Télécharger « dupont.pdf »/ })).toHaveAttribute('href', '/v1/contracts/k1/imported-document');
  await user.click(screen.getByRole('tab', { name: 'Signature' }));
  expect(screen.getByText(/aucune nouvelle signature ne sera demandée/)).toBeInTheDocument();
});

test('liste des contrats : pastille « Importé » et lien de validation pour IMPORTED_PENDING_VALIDATION', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({
    data: [
      { id: 'k1', reference: 'IMP-1', title: 'Repris', customer: { name: 'Dupont' }, status: 'IMPORTED_PENDING_VALIDATION', endDate: null, origin: 'IMPORTED' },
      { id: 'k2', reference: 'LSI-2', title: 'Natif', customer: { name: 'Martin' }, status: 'ACTIVE', endDate: null, origin: 'NATIVE' },
    ],
    pagination: { nextCursor: null, hasMore: false },
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><ContractsPage /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('link', { name: 'IMP-1' })).toBeInTheDocument());
  expect(screen.getAllByText('Importé')).toHaveLength(1);
  expect(screen.getByRole('link', { name: /Valider l’import IMP-1/ })).toHaveAttribute('href', '/contracts/k1/import');
  expect(screen.queryByRole('link', { name: /Valider l’import LSI-2/ })).not.toBeInTheDocument();
});
