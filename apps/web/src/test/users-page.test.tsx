import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersPage } from '../features/users/users-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('liste les utilisateurs et permet de créer un interne', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).endsWith('/v1/users') && (init?.method ?? 'GET') === 'GET')
      return new Response(JSON.stringify({ items: [{ id: 'u1', email: 'a@lsi.fr', fullName: 'Alice', kind: 'INTERNAL', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], customer: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'u2' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<UsersPage />);
  await waitFor(() => expect(screen.getByText('a@lsi.fr')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Nouvel utilisateur/ }));
  await userEvent.type(screen.getByLabelText(/Email/), 'nouveau@lsi.fr');
  await userEvent.type(screen.getByLabelText(/Nom/), 'Nouveau');
  await userEvent.click(screen.getByRole('button', { name: /Créer/ }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
});
