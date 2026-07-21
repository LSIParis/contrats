import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditPage } from '../features/audit/audit-page.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AuditPage /></MemoryRouter></QueryClientProvider>);
}

const entry = { id: 'a1', occurredAt: '2026-07-21T10:00:00Z', actorUserId: 'u1', actorKind: 'INTERNAL', action: 'POST /v1/contracts/:id/submit', resourceType: 'contracts', resourceId: 'c1', requestId: null, hash: 'abcd', prevHash: null, after: {} };

test('affiche les entrées d’audit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [entry] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText(/POST \/v1\/contracts/)).toBeInTheDocument());
});

test('le bouton « Vérifier l’intégrité » affiche le résultat', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).includes('/verify') ? { ok: true, brokenAt: null } : { items: [entry] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Vérifier l.intégrité/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Vérifier l.intégrité/i }));
  await waitFor(() => expect(screen.getByText(/intègre/i)).toBeInTheDocument());
});
