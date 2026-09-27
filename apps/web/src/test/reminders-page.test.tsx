import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RemindersPage } from '../features/reminders/reminders-page.js';
import { routeFetch } from './fetch-router.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><RemindersPage /></MemoryRouter></QueryClientProvider>);
}

test('liste les rappels en attente puis filtre par statut', async () => {
  const api = routeFetch({
    'GET /v1/reminders': (_b: unknown, url: string) => (url.includes('status=PENDING')
      ? { items: [{ id: 'r1', contractId: 'k1', contractReference: 'LSI-2026-0001', kind: 'NOTICE_DEADLINE', offsetDays: 30, dueAt: '2026-10-01T00:00:00Z', status: 'PENDING', late: true }], total: 1 }
      : { items: [], total: 0 }),
  });
  wrap();
  expect(await screen.findByRole('link', { name: 'LSI-2026-0001' })).toHaveAttribute('href', '/contracts/k1?onglet=echeances');
  expect(screen.getByText('Date limite de dénonciation')).toBeInTheDocument();
  expect(screen.getByText('En retard')).toBeInTheDocument();
  expect(screen.getByText(/J-30/)).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Statut'), '');
  expect(await screen.findByText('Aucun rappel.')).toBeInTheDocument();
  await waitFor(() => expect(api.calls.some((c) => c.url === '/v1/reminders')).toBe(true));
});
