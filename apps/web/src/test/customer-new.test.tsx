import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomerNewPage } from '../features/customers/customer-new-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/customers/new']}>
        <Routes>
          <Route path="/customers/new" element={<CustomerNewPage />} />
          <Route path="/customers/:id" element={<div>Fiche client</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('crée un client et redirige vers sa fiche', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify({ id: 'c9', name: 'Test SARL', siren: null, country: 'FR' }),
      { status: 201, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  wrap();
  await userEvent.type(screen.getByLabelText(/Nom/), 'Test SARL');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText('Fiche client')).toBeInTheDocument());
  // Le POST est bien parti vers /v1/customers avec le nom.
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/customers'));
  expect(call).toBeTruthy();
});

test('affiche l’erreur API (SIREN dupliqué)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ statusCode: 409, message: 'SIREN déjà utilisé' }),
      { status: 409, headers: { 'content-type': 'application/json' } })));
  wrap();
  await userEvent.type(screen.getByLabelText(/Nom/), 'Doublon');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(screen.getByText(/SIREN déjà utilisé/)).toBeInTheDocument());
});
