import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminateContract } from '../features/contracts/terminate-contract.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const props = { contractId: 'k1', customerName: 'ACME', noticePeriodDays: 30, roles: ['ACCOUNT_MANAGER'], allowedActions: ['TERMINATE'] };

test('rien si TERMINATE non autorisé', () => {
  wrap(<TerminateContract {...props} allowedActions={[]} />);
  expect(screen.queryByRole('button', { name: /Résilier/ })).not.toBeInTheDocument();
});

test('la confirmation exige le nom du client puis POST /terminate', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/terminate');
    return new Response(JSON.stringify({ status: 'TERMINATED', noticeRespected: true }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  await userEvent.type(screen.getByLabelText(/Motif/), 'Fin de contrat');
  // bouton confirmer désactivé tant que le nom ne correspond pas
  const confirm = screen.getByRole('button', { name: /Confirmer la résiliation/ });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});
