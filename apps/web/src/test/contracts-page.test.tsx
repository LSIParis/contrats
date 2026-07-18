import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractsPage } from '../features/contracts/contracts-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts']}>
        <ContractsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche les contrats renvoyés par l’API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({
      data: [{ id: 'c1', reference: 'LSI-1', title: 'Maintenance', customer: { name: 'Dupont' }, status: 'ACTIVE', endDate: '2026-09-01' }],
      pagination: { nextCursor: null, hasMore: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  wrap();
  await waitFor(() => expect(screen.getByText('LSI-1')).toBeInTheDocument());
  expect(screen.getByText('Dupont')).toBeInTheDocument();
  expect(screen.queryByText(/Charger plus/i)).not.toBeInTheDocument();
});

test('charge la page suivante via « Charger plus »', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cursor=cur1')) {
      return new Response(JSON.stringify({
        data: [{ id: 'c2', reference: 'LSI-2', title: 'Support', customer: { name: 'Martin' }, status: 'ACTIVE', endDate: '2026-10-01' }],
        pagination: { nextCursor: null, hasMore: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [{ id: 'c1', reference: 'LSI-1', title: 'Maintenance', customer: { name: 'Dupont' }, status: 'ACTIVE', endDate: '2026-09-01' }],
      pagination: { nextCursor: 'cur1', hasMore: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  wrap();
  await waitFor(() => expect(screen.getByText('LSI-1')).toBeInTheDocument());

  const button = await screen.findByRole('button', { name: /Charger plus/i });
  await user.click(button);

  await waitFor(() => expect(screen.getByText('LSI-2')).toBeInTheDocument());
  expect(screen.getByText('Martin')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Charger plus/i })).not.toBeInTheDocument();
});

test('un échec de « Charger plus » n’efface pas la liste déjà chargée', async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ id: 'c1', reference: 'LSI-1', title: 'Maintenance', customer: { name: 'Dupont' }, status: 'ACTIVE', endDate: '2026-09-01' }],
        pagination: { nextCursor: 'cur1', hasMore: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    .mockResolvedValueOnce(new Response('erreur', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  wrap();
  await waitFor(() => expect(screen.getByText('LSI-1')).toBeInTheDocument());

  const button = await screen.findByRole('button', { name: /Charger plus/i });
  await user.click(button);

  const retry = await screen.findByRole('button', { name: /Échec du chargement/i });
  expect(retry).toBeInTheDocument();
  expect(screen.getByText('LSI-1')).toBeInTheDocument();
  expect(screen.queryByText('Erreur de chargement.')).not.toBeInTheDocument();
});
