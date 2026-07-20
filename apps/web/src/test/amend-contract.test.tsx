import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AmendContract } from '../features/contracts/amend-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
const base = { contractId: 'k1', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], openAmendment: null, amends: null };

test('Créer un avenant → formulaire → POST /amend', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/amend');
    return new Response(JSON.stringify({ id: 'av1', reference: 'LSI-2026-0002' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<AmendContract {...base} />);
  await userEvent.click(screen.getByRole('button', { name: /Créer un avenant/ }));
  await userEvent.type(screen.getByLabelText(/Description/), 'Extension');
  await userEvent.click(screen.getByRole('button', { name: /Créer l.avenant/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau quand un avenant est en cours', () => {
  wrap(<AmendContract {...base} openAmendment={{ id: 'av1', reference: 'LSI-2026-0002', status: 'DRAFT' }} />);
  expect(screen.getByText(/Avenant en cours/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0002/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Créer un avenant/ })).not.toBeInTheDocument();
});

test('bandeau parent pour un avenant', () => {
  wrap(<AmendContract {...base} status="DRAFT" amends={{ id: 'p1', reference: 'LSI-2026-0001' }} />);
  expect(screen.getByText(/Avenant de/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0001/)).toBeInTheDocument();
});

test('pas de bouton "Créer un avenant" sur un avenant lui-même (avenant-d’avenant non supporté)', () => {
  // Un contrat qui EST un avenant (amends renseigné) est ACTIVE/SIGNED-able,
  // mais ne doit jamais proposer de créer un avenant sur lui-même.
  wrap(<AmendContract {...base} status="ACTIVE" amends={{ id: 'p1', reference: 'LSI-2026-0001' }} />);
  expect(screen.queryByRole('button', { name: /Créer un avenant/ })).not.toBeInTheDocument();
});
