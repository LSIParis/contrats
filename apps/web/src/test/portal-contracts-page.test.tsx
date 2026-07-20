import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalContractsPage } from '../portal/portal-contracts-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('la liste affiche les contrats du portail', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'c1', reference: 'LSI-2026-0001', title: 'Maintenance', status: 'ACTIVE', endDate: '2026-12-31' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractsPage />);
  await waitFor(() => expect(screen.getByText('LSI-2026-0001')).toBeInTheDocument());
  expect(screen.getByText(/Maintenance/)).toBeInTheDocument();
});
