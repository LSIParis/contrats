import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationBell } from '../features/notifications/notification-bell.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><NotificationBell /></MemoryRouter></QueryClientProvider>);
}

const payload = { items: [{ id: 'n1', type: 'CLIENT_COMMENT', subject: 'Message client', body: 'Bonjour', relatedContractId: 'c1', status: 'QUEUED', readAt: null, createdAt: '2026-07-21T10:00:00Z' }], unreadCount: 1 };

test('affiche la pastille de non-lues puis la liste au clic', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
  expect(screen.getByText('Message client')).toBeInTheDocument();
});

test('« Tout marquer lu » poste sur read-all', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(url.toString().endsWith('read-all') ? { count: 1 } : payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
  fireEvent.click(screen.getByRole('button', { name: /Tout marquer lu/i }));
  await waitFor(() => expect(calls.some((c) => c.includes('read-all') && c.startsWith('POST'))).toBe(true));
});
