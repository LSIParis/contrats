import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SendForSignature } from '../features/contracts/send-for-signature.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const signers = [
  { id: 's1', party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0 },
  { id: 's2', party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1 },
];

test('confirme et envoie avec un Idempotency-Key', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/send-for-signature');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    return new Response(JSON.stringify({ signatureRequestId: 'r1', status: 'SENT' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  vi.stubGlobal('crypto', { randomUUID: () => 'idem-123' } as never);

  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Envoyer en signature/ }));
  // le panneau de confirmation liste les signataires
  expect(screen.getByText(/Jean/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Confirmer l’envoi/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('sans SEND_FOR_SIGNATURE dans allowed-actions, pas de bouton', () => {
  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['CANCEL']} roles={['MSP_ADMIN']} />);
  expect(screen.queryByRole('button', { name: /Envoyer en signature/ })).not.toBeInTheDocument();
});
