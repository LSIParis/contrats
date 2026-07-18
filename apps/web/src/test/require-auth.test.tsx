import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireAuth } from '../shell/require-auth.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('un 401 affiche l’écran de connexion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  wrap(<RequireAuth><div>secret</div></RequireAuth>);
  await waitFor(() =>
    expect(screen.getByText(/Se connecter avec Microsoft 365/i)).toBeInTheDocument(),
  );
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test('authentifié : le contenu protégé s’affiche', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ userId: 'u1', fullName: 'Sylvie', roles: ['ACCOUNT_MANAGER'] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  wrap(<RequireAuth><div>secret</div></RequireAuth>);
  await waitFor(() => expect(screen.getByText('secret')).toBeInTheDocument());
});
