import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignatureActions } from '../features/contracts/signature-actions.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('relance : POST vers /signature/remind', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/signature/remind');
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({ reminded: 2 }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignatureActions contractId="k1" status="PENDING_SIGNATURE" roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Relancer/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('révoquer demande confirmation puis POST /signature/revoke', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    expect(String(url)).toContain('/signature/revoke');
    return new Response(JSON.stringify({ status: 'REVOKED' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignatureActions contractId="k1" status="PENDING_SIGNATURE" roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Révoquer/ }));
  await userEvent.click(screen.getByRole('button', { name: /Confirmer la révocation/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('hors PENDING_SIGNATURE, aucun bouton', () => {
  wrap(<SignatureActions contractId="k1" status="APPROVED" roles={['MSP_ADMIN']} />);
  expect(screen.queryByRole('button', { name: /Relancer/ })).not.toBeInTheDocument();
});
