import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
});
