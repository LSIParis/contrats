import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { CustomersPage } from '../features/customers/customers-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><CustomersPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche les clients renvoyés par l’API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ items: [{ id: 'c1', name: 'Dupont SAS', siren: '123456789', country: 'FR', status: 'ACTIVE', contractCount: 3 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
  wrap();
  await waitFor(() => expect(screen.getByText('Dupont SAS')).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Dupont SAS/ })).toHaveAttribute('href', '/customers/c1');
});
