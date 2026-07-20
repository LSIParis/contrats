import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RenewContract } from '../features/contracts/renew-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
const base = { contractId: 'k1', status: 'ACTIVE', roles: ['ACCOUNT_MANAGER'], renewal: null, predecessor: null };

test('bouton Renouveler pour un contrat ACTIVE sans renouvellement', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/renew');
    return new Response(JSON.stringify({ id: 'new1', reference: 'LSI-2027-0001' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<RenewContract {...base} />);
  await userEvent.click(screen.getByRole('button', { name: /Renouveler/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau + Refuser quand un renouvellement PENDING existe', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/renew/refuse');
    return new Response(JSON.stringify({ status: 'REFUSED' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<RenewContract {...base} renewal={{ status: 'PENDING', newContractId: 'new1', successor: { reference: 'LSI-2027-0001', status: 'DRAFT' } }} />);
  expect(screen.getByText(/LSI-2027-0001/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Refuser/ }));
  await userEvent.type(screen.getByLabelText(/Motif/), 'Non');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer le refus/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('bandeau prédécesseur pour un successeur', () => {
  wrap(<RenewContract {...base} status="DRAFT" predecessor={{ id: 'p1', reference: 'LSI-2026-0009' }} />);
  expect(screen.getByText(/Renouvellement de/)).toBeInTheDocument();
  expect(screen.getByText(/LSI-2026-0009/)).toBeInTheDocument();
});
