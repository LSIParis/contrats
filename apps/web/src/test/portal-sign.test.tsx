import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalContractPage } from '../portal/portal-contract-page.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/portal/contracts/k1']}>{ui}</MemoryRouter></QueryClientProvider>);
}
const DETAIL = { reference: 'LSI-2026-0001', title: 'Maintenance', status: 'PENDING_SIGNATURE', endDate: '2026-12-31', amountCents: null, currency: 'EUR', signers: [{ party: 'CLIENT', fullName: 'Nathalie', status: 'SENT', signedAt: null }], mySignature: { status: 'SENT' } };

test('affiche un lien Signer quand une signature est en attente', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DETAIL), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractPage />);
  const link = await screen.findByRole('link', { name: /Signer le document/ });
  expect(link).toHaveAttribute('href', expect.stringContaining('/sign'));
});

test('pas de lien Signer si déjà signé', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...DETAIL, mySignature: { status: 'SIGNED' } }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<PortalContractPage />);
  await screen.findByText(/Maintenance/);
  expect(screen.queryByRole('link', { name: /Signer le document/ })).not.toBeInTheDocument();
});
