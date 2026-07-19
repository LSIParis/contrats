import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionsPage } from '../features/contracts/versions-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><VersionsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test('affiche l’historique des versions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ items: [{ id: 'v2', versionNumber: 2, changeSummary: 'maj', createdAt: '2026-07-19' }, { id: 'v1', versionNumber: 1, changeSummary: 'init', createdAt: '2026-07-18' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
  wrap();
  await waitFor(() => expect(screen.getByText(/Version 2/)).toBeInTheDocument());
  expect(screen.getByText(/Version 1/)).toBeInTheDocument();
});
