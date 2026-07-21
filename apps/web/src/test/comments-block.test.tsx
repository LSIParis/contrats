import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CommentsBlock } from '../features/contracts/comments-block.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CommentsBlock contractId="c1" /></QueryClientProvider>);
}

test('distingue visuellement INTERNAL et SHARED', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 'm1', body: 'Note interne', visibility: 'INTERNAL', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T10:00:00Z' },
    { id: 'm2', body: 'Visible client', visibility: 'SHARED', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T11:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Note interne')).toBeInTheDocument());
  expect(screen.getByText('Interne')).toBeInTheDocument();
  expect(screen.getByText('Partagé client')).toBeInTheDocument();
});

test('choisir SHARED affiche un avertissement « visible du client »', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByLabelText(/Partagé client/)).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText(/Partagé client/));
  expect(screen.getByText(/visible du client/i)).toBeInTheDocument();
});

function stubWithMe(roles: string[]) {
  const item = { id: 'm1', body: 'Note interne', visibility: 'INTERNAL', resolvedAt: null, editedAt: null, deletedAt: null, authorUserId: 'other', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T10:00:00Z' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).endsWith('/auth/me') ? { userId: 'me', roles } : { items: [item] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
}

test('« Partager avec le client » n’apparaît que pour un rôle SHARE-capable', async () => {
  stubWithMe(['ACCOUNT_MANAGER']);
  wrap();
  await waitFor(() => expect(screen.getByText('Note interne')).toBeInTheDocument());
  expect(screen.getByText(/Partager avec le client/i)).toBeInTheDocument();
});

test('un TECHNICIAN ne voit pas « Partager avec le client »', async () => {
  stubWithMe(['TECHNICIAN']);
  wrap();
  await waitFor(() => expect(screen.getByText('Note interne')).toBeInTheDocument());
  expect(screen.queryByText(/Partager avec le client/i)).not.toBeInTheDocument();
});

test('un commentaire résolu est marqué, un supprimé affiche « message supprimé »', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 'm1', body: 'Traité', visibility: 'INTERNAL', resolvedAt: '2026-07-21T10:00:00Z', editedAt: null, deletedAt: null, author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T09:00:00Z' },
    { id: 'm2', body: null, visibility: 'SHARED', resolvedAt: null, editedAt: null, deletedAt: '2026-07-21T11:00:00Z', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T09:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Traité')).toBeInTheDocument());
  expect(screen.getByText(/Résolu/i)).toBeInTheDocument();
  expect(screen.getByText(/message supprimé/i)).toBeInTheDocument();
});
