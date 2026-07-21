import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContractsPage } from '../features/contracts/contracts-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('la bascule « Archivés » ajoute ?archived=true à la requête', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [], pagination: { nextCursor: null, hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<ContractsPage />);
  await waitFor(() => expect(screen.getByLabelText(/Archivés/i)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText(/Archivés/i));
  await waitFor(() => expect(calls.some((c) => c.includes('archived=true'))).toBe(true));
});
