import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PortalContractPage } from '../portal/portal-contract-page.js';
import { routeFetch } from './fetch-router.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/portal/contracts/k1']}>
        <Routes><Route path="/portal/contracts/:id" element={<PortalContractPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const DETAIL = { id: 'k1', reference: 'LSI-2026-0007', title: 'Infogérance', status: 'SENT_TO_CLIENT', category: 'MAINTENANCE', startDate: null, endDate: null, amountCents: null, currency: 'EUR', billingFrequency: 'MONTHLY', signers: [], mySignature: null };
const PROPOSAL = { contractId: 'k1', reference: 'LSI-2026-0007', title: 'Infogérance', status: 'SENT_TO_CLIENT', version: { id: 'ver-3', versionNumber: 3, bodyHtml: '<h2>Article 1 — Objet</h2><p>Infogérance de 40 postes.</p>', createdAt: '2026-09-20T10:00:00Z' } };
const base = {
  'GET /v1/portal/me': { email: 'nathalie@client.fr', customerName: 'Client SA' },
  'GET /v1/portal/contracts/k1/comments': { items: [] },
  'GET /v1/portal/contracts/k1/proposal': PROPOSAL,
};

test('le client lit la proposition et l’accepte (version présentée, identité de la session)', async () => {
  const api = routeFetch({ ...base, 'GET /v1/portal/contracts/k1': DETAIL, 'POST /v1/portal/contracts/k1/accept': { acceptanceId: 'a1', status: 'ACCEPTED', versionId: 'ver-3', acceptedAt: '2026-09-27T10:00:00Z' } });
  wrap();
  expect(await screen.findByText('Infogérance de 40 postes.')).toBeInTheDocument();
  expect(screen.getByText(/Proposition — version 3/)).toBeInTheDocument();
  expect(await screen.findByText('nathalie@client.fr')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Accepter la proposition' });
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByLabelText(/J’ai lu la proposition \(version 3\) et je l’accepte/));
  await userEvent.click(button);
  expect(await screen.findByText(/Vous avez accepté cette proposition/)).toBeInTheDocument();
  expect(api.find('POST', '/v1/portal/contracts/k1/accept')[0]!.body).toEqual({ versionId: 'ver-3' });
});

test('un lecteur client (403) voit un message explicite', async () => {
  routeFetch({ ...base, 'GET /v1/portal/contracts/k1': DETAIL, 'POST /v1/portal/contracts/k1/accept': [403, { message: 'Action « portal.accept » réservée' }] });
  wrap();
  await userEvent.click(await screen.findByLabelText(/J’ai lu la proposition/));
  await userEvent.click(screen.getByRole('button', { name: 'Accepter la proposition' }));
  expect(await screen.findByText(/Seuls les signataires désignés/)).toBeInTheDocument();
});

test('proposition acceptée : plus de bouton, confirmation', async () => {
  routeFetch({ ...base, 'GET /v1/portal/contracts/k1': { ...DETAIL, status: 'ACCEPTED' } });
  wrap();
  expect(await screen.findByText(/Vous avez accepté cette proposition/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Accepter la proposition' })).not.toBeInTheDocument();
});

test('signature intégrée dans le portail : cadre DocuSeal du signataire connecté', async () => {
  routeFetch({
    ...base,
    'GET /v1/portal/contracts/k1': { ...DETAIL, status: 'PENDING_SIGNATURE', signers: [{ party: 'CLIENT', fullName: 'Nathalie', status: 'SENT', signedAt: null }], mySignature: { status: 'SENT' } },
    'GET /v1/portal/contracts/k1/signing': { alreadySigned: false, embedSrc: 'https://sign.lsi.fr/s/abc' },
  });
  wrap();
  await userEvent.click(await screen.findByRole('button', { name: /Signer ici/ }));
  const frame = await screen.findByTitle(/Signature électronique du contrat LSI-2026-0007/);
  expect(frame).toHaveAttribute('src', 'https://sign.lsi.fr/s/abc');
  expect(screen.getByRole('link', { name: /Signer le document/ })).toHaveAttribute('href', '/v1/portal/contracts/k1/sign');
});

test('signature intégrée indisponible (503 DOCUSEAL_UNAVAILABLE) : message clair', async () => {
  routeFetch({
    ...base,
    'GET /v1/portal/contracts/k1': { ...DETAIL, status: 'PENDING_SIGNATURE', mySignature: { status: 'SENT' } },
    'GET /v1/portal/contracts/k1/signing': [503, { code: 'DOCUSEAL_UNAVAILABLE', detail: 'Service indisponible', retryable: true }],
  });
  wrap();
  await userEvent.click(await screen.findByRole('button', { name: /Signer ici/ }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/momentanément indisponible/));
});
