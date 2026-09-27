import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from '../shell/app-shell.js';

function respond(url: string): Response {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/v1/auth/me')) return json({ userId: 'u1', fullName: 'Sylvie Martin', roles: ['MSP_ADMIN'] });
  if (url.includes('/v1/notifications')) return json({ items: [], unreadCount: 0 });
  return new Response('', { status: 404 });
}

test('coquille : navigation nommée, entrée active signalée, titre de section, lien d’évitement', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts/42']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/contracts/:id" element={<p>Fiche contrat</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Contrats' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Aller au contenu' })).toHaveAttribute('href', '#contenu');
  expect(screen.getByRole('main')).toHaveTextContent('Fiche contrat');
  expect(screen.getByAltText('LSI Maintenance')).toBeInTheDocument();
  // Rôles traduits, liens d'administration visibles pour un administrateur.
  await waitFor(() => expect(screen.getByText('Sylvie Martin')).toBeInTheDocument());
  expect(screen.getByText('(Administrateur)')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  vi.unstubAllGlobals();
});
