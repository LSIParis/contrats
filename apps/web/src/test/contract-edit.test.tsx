import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractEditPage } from '../features/contracts/contract-edit-page.js';

// L'éditeur TipTap est remplacé par un stub : ce test cible la logique de
// chargement/sauvegarde/navigation, pas le moteur d'édition (couvert en Task 4).
vi.mock('../features/contracts/content-editor.js', () => ({
  ContentEditor: ({ onSave }: { onSave: (h: string) => void }) => (
    <button onClick={() => onSave('<p>édité</p>')}>Enregistrer</button>
  ),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts/k1/edit']}>
        <Routes>
          <Route path="/contracts/:id/edit" element={<ContractEditPage />} />
          <Route path="/contracts/:id" element={<div>Fiche contrat</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('charge le contrat, enregistre le contenu et revient à la fiche', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/contracts/k1') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ contract: { status: 'DRAFT', currentVersionId: null }, customer: { name: 'X' }, signatureRequest: null, reminders: [], timeline: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // PUT content
    expect(init?.method).toBe('PUT');
    return new Response(JSON.stringify({ id: 'v1', versionNumber: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap();
  await waitFor(() => expect(screen.getByRole('button', { name: /Enregistrer/ })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
  await waitFor(() => expect(screen.getByText('Fiche contrat')).toBeInTheDocument());
});
