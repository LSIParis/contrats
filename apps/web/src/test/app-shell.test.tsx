import { render, screen, waitFor, within } from '@testing-library/react';
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
  expect(screen.getByRole('img', { name: 'LSI Contrats' })).toBeInTheDocument();
  // Rôles traduits, liens d'administration visibles pour un administrateur.
  await waitFor(() => expect(screen.getByText('Sylvie Martin')).toBeInTheDocument());
  expect(screen.getByText('(Administrateur)')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  // Menu découpé en trois sections, dans cet ordre.
  const text = nav.textContent ?? '';
  const positions = ['Devis proposition', 'Contrat', 'Administration'].map((label) => {
    expect(within(nav).getByText(label)).toBeInTheDocument();
    return text.indexOf(label);
  });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // Chaque section commence par le tableau de bord.
  const links = within(nav).getAllByRole('link').map((a) => a.textContent);
  expect(links.filter((name) => name === 'Tableau de bord')).toHaveLength(3);
  for (const label of ['Devis proposition', 'Contrat', 'Administration']) {
    const section = within(nav).getByText(label).parentElement as HTMLElement;
    expect(within(section).getAllByRole('link')[0]).toHaveTextContent('Tableau de bord');
  }
  // Paramètres : hors du menu principal, dans sa propre zone en bas de la barre latérale.
  const settingsLink = screen.getByRole('link', { name: 'Paramètres' });
  expect(within(nav).queryByRole('link', { name: 'Paramètres' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Paramètres' })).getByRole('link', { name: 'Paramètres' })).toBe(settingsLink);
  expect(nav.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  vi.unstubAllGlobals();
});
