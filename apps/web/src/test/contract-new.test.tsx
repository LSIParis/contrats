import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractNewPage } from '../features/contracts/contract-new-page.js';

function wrap(entry = '/contracts/new?customerId=c1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/contracts/new" element={<ContractNewPage />} />
          <Route path="/contracts/:id" element={<div>Fiche contrat</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('crée un contrat (montant € → centimes) et redirige', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/v1/customers')) {
      return new Response(JSON.stringify({ items: [{ id: 'c1', name: 'Dupont SAS', siren: null, country: 'FR', contractCount: 0 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // POST /v1/contracts
    const body = JSON.parse(String(init?.body));
    // 1500,50 € → 150050 centimes
    expect(body.amountCents).toBe(150050);
    expect(body.customerId).toBe('c1');
    return new Response(JSON.stringify({ id: 'k1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap();
  await waitFor(() => expect(screen.getByDisplayValue('Dupont SAS')).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText(/Titre/), 'Maintenance 2026');
  await userEvent.type(screen.getByLabelText(/Montant/), '1500,50');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText('Fiche contrat')).toBeInTheDocument());
});
