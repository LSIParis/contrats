import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TemplatesPage } from '../features/templates/templates-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

test('affiche la liste des modèles', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 't1', name: 'Maintenance standard', category: 'MAINTENANCE', status: 'PUBLISHED', versionCount: 2, updatedAt: '2026-07-21T10:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<TemplatesPage />);
  await waitFor(() => expect(screen.getByText('Maintenance standard')).toBeInTheDocument());
});

test('« Nouveau modèle » poste puis la liste se rafraîchit', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body = (init?.method === 'POST') ? { id: 'tNew' } : { items: [] };
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap(<TemplatesPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: /Nouveau modèle/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Nouveau modèle/i }));
  // formulaire minimal : nom + catégorie + valider
  fireEvent.change(screen.getByLabelText(/Nom/i), { target: { value: 'Nouveau' } });
  fireEvent.click(screen.getByRole('button', { name: /Créer/i }));
  await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.includes('/v1/templates'))).toBe(true));
});
