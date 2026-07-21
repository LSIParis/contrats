import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PortalContractPage } from '../portal/portal-contract-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/portal/contracts/c1']}>
        <Routes><Route path="/portal/contracts/:id" element={<PortalContractPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const detail = { id: 'c1', reference: 'LSI-2026-0001', title: 'Maintenance', status: 'ACTIVE', category: 'MAINTENANCE', startDate: null, endDate: null, amountCents: null, currency: null, billingFrequency: null, signers: [], mySignature: null };

test('la fiche portail affiche les commentaires SHARED', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/comments')) return new Response(JSON.stringify({ items: [{ id: 'm1', body: 'Réponse LSI', author: { fullName: 'Sylvie M.', kind: 'INTERNAL' }, createdAt: '2026-07-21T10:00:00Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Réponse LSI')).toBeInTheDocument());
});

test('le bouton « Demander un renouvellement » pré-remplit la zone de saisie', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/comments')) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Demander un renouvellement/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Demander un renouvellement/ }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toMatch(/renouveler/i);
});
