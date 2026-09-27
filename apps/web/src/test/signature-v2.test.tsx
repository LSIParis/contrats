import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SendForSignature } from '../features/contracts/send-for-signature.js';
import { InternalSigning } from '../features/signature/internal-signing.js';
import { SignatureAvailabilityBanner } from '../features/signature/signature-availability.js';
import type { Me } from '../lib/queries.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const signers = [
  { id: 's1', party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0 },
  { id: 's2', party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1 },
];
const SIGNATORY: Me = { userId: 'u9', fullName: 'Marc', email: 'Marc@LSI.fr', kind: 'INTERNAL', roles: ['INTERNAL_SIGNATORY'], customerId: null, permissions: ['contracts.signInternal', 'contracts.read'] };

test('ordre de signature et signature intégrée transmis ; « par défaut » n’envoie pas d’ordre', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'idem-1' } as never);
  const api = routeFetch({ 'POST /v1/contracts/k1/send-for-signature': { signatureRequestId: 'r1', status: 'SENT' } });
  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['ACCOUNT_MANAGER']} availability={{ configured: true, available: true, enabled: true }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer en signature' }));
  expect(screen.getByLabelText('Ordre de signature')).toHaveValue('');
  await userEvent.selectOptions(screen.getByLabelText('Ordre de signature'), 'LSI_THEN_CLIENT');
  await userEvent.click(screen.getByLabelText(/Signature intégrée/));
  await userEvent.type(screen.getByLabelText('Expiration (jours)'), '15');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’envoi' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/send-for-signature')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/send-for-signature')[0]!.body).toEqual({ signingOrder: 'LSI_THEN_CLIENT', delivery: 'EMBEDDED', expireInDays: 15 });
});

test('valeurs par défaut : seul le mode e-mail est envoyé', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'idem-2' } as never);
  const api = routeFetch({ 'POST /v1/contracts/k1/send-for-signature': { signatureRequestId: 'r1', status: 'SENT' } });
  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer en signature' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’envoi' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/send-for-signature')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/send-for-signature')[0]!.body).toEqual({ delivery: 'EMAIL' });
});

test('503 DOCUSEAL_UNAVAILABLE à l’envoi : message français', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'idem-3' } as never);
  routeFetch({ 'POST /v1/contracts/k1/send-for-signature': [503, { code: 'DOCUSEAL_UNAVAILABLE', detail: 'x', retryable: true }] });
  wrap(<SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer en signature' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’envoi' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/momentanément indisponible/);
});

test('signature désactivée : bandeau et envoi impossible', () => {
  const off = { configured: false, available: false, enabled: false };
  wrap(<>
    <SignatureAvailabilityBanner availability={off} />
    <SendForSignature contractId="k1" signers={signers} allowedActions={['SEND_FOR_SIGNATURE']} roles={['MSP_ADMIN']} availability={off} />
  </>);
  expect(screen.getByRole('alert')).toHaveTextContent(/n’est pas activée pour votre organisation/);
  expect(screen.getByRole('button', { name: 'Envoyer en signature' })).toBeDisabled();
});

test('instance DocuSeal injoignable : bandeau « momentanément indisponible »', () => {
  wrap(<SignatureAvailabilityBanner availability={{ configured: true, available: false, enabled: false }} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/momentanément indisponible/);
});

test('signataire interne : signature intégrée dans un cadre', async () => {
  routeFetch({ 'GET /v1/contracts/k1/signing': { alreadySigned: false, embedSrc: 'https://sign.lsi.fr/s/xyz' } });
  wrap(<InternalSigning contractId="k1" reference="LSI-1" status="PARTIALLY_SIGNED" me={SIGNATORY}
    signers={[{ party: 'CLIENT', email: 'jean@c.fr', status: 'SIGNED' }, { party: 'LSI', email: 'marc@lsi.fr', status: 'SENT' }]} />);
  await userEvent.click(screen.getByRole('button', { name: /Signer au nom de LSI-Maintenance/ }));
  expect(await screen.findByTitle('Signature électronique du contrat LSI-1')).toHaveAttribute('src', 'https://sign.lsi.fr/s/xyz');
});

test('signataire interne : déjà signé, ou pas signataire de ce contrat', async () => {
  routeFetch({ 'GET /v1/contracts/k1/signing': { alreadySigned: true, embedSrc: null } });
  const { unmount } = wrap(<InternalSigning contractId="k1" reference="LSI-1" status="PENDING_SIGNATURE" me={SIGNATORY}
    signers={[{ party: 'LSI', email: 'marc@lsi.fr', status: 'VIEWED' }]} />);
  await userEvent.click(screen.getByRole('button', { name: /Signer au nom de LSI-Maintenance/ }));
  expect(await screen.findByText('Vous avez déjà signé ce document.')).toBeInTheDocument();
  unmount();
  wrap(<InternalSigning contractId="k1" reference="LSI-1" status="PENDING_SIGNATURE" me={SIGNATORY}
    signers={[{ party: 'LSI', email: 'autre@lsi.fr', status: 'SENT' }]} />);
  expect(screen.queryByRole('button', { name: /Signer au nom/ })).not.toBeInTheDocument();
});
