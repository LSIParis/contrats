import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from '../shell/app-shell.js';
import { renderWithClient } from './api-mock.js';
import { routeFetch } from './fetch-router.js';

afterEach(() => vi.unstubAllGlobals());

function mount(me: Record<string, unknown>) {
  routeFetch({ 'GET /v1/auth/me': me, 'GET /v1/notifications': { items: [], unreadCount: 0 } });
  renderWithClient(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/proposals" element={<p>Liste</p>} />
      </Route>
    </Routes>,
    ['/proposals'],
  );
}

test('entrée « Propositions » (proposals.read), active sur /proposals ; administration des propositions pour l’admin', async () => {
  mount({ userId: 'u', fullName: 'Admin', roles: ['MSP_ADMIN'] });
  const link = await screen.findByRole('link', { name: 'Propositions' });
  expect(link).toHaveAttribute('href', '/proposals');
  expect(link).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Administration des propositions' })).toHaveAttribute('href', '/proposal-admin/templates');
});

test('permissions calculées par l’API : sans proposals.read, pas d’entrée', async () => {
  mount({ userId: 'u', fullName: 'Client', roles: ['ACCOUNT_MANAGER'], permissions: ['contracts.write'] });
  await waitFor(() => expect(screen.getByText('Client')).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: 'Propositions' })).not.toBeInTheDocument();
});

test('commercial : entrée « Propositions » sans l’administration', async () => {
  mount({ userId: 'u', fullName: 'Camille', roles: ['ACCOUNT_MANAGER'] });
  expect(await screen.findByRole('link', { name: 'Propositions' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Administration des propositions' })).not.toBeInTheDocument();
});
