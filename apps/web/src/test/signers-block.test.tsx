import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignersBlock } from '../features/contracts/signers-block.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('liste les signataires et ajoute un signataire LSI', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({ id: 's9', party: 'LSI', fullName: 'Marc', email: 'm@lsi.fr', signingOrder: 0 }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<SignersBlock contractId="k1" editable signers={[{ id: 's1', party: 'CLIENT', fullName: 'Jean', email: 'j@c.fr', signingOrder: 1 }]} />);
  expect(screen.getByText('Jean')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Signataire LSI/ }));
  await userEvent.type(screen.getByLabelText(/Nom/), 'Marc');
  await userEvent.type(screen.getByLabelText(/Email/), 'm@lsi.fr');
  await userEvent.click(screen.getByRole('button', { name: /Ajouter/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});
