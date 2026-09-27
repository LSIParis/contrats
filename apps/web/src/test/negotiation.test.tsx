import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NegotiationActions } from '../features/negotiation/negotiation-actions.js';
import { AcceptancesBlock } from '../features/negotiation/acceptances-block.js';
import type { Me } from '../lib/queries.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const AM: Me = { userId: 'u1', fullName: 'Paul', email: 'paul@lsi.fr', kind: 'INTERNAL', roles: ['ACCOUNT_MANAGER'], customerId: null, permissions: ['contracts.negotiate'] };
const READER: Me = { ...AM, roles: ['READER'], permissions: ['contracts.read'] };

test('APPROVED : « Envoyer au client » après confirmation', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/send-to-client': { status: 'SENT_TO_CLIENT' } });
  wrap(<NegotiationActions contractId="k1" currentVersionId="v1" allowedActions={['EDIT_CONTENT', 'SEND_TO_CLIENT', 'SEND_FOR_SIGNATURE']} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer au client' }));
  const dialog = screen.getByRole('dialog', { name: 'Envoyer la proposition au client' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmer l’envoi' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/send-to-client')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('SENT_TO_CLIENT : ouvrir une négociation (motif obligatoire) ; erreur serveur affichée', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/negotiate': [409, { code: 'RM-04', detail: 'Transition refusée depuis ce statut.' }] });
  wrap(<NegotiationActions contractId="k1" currentVersionId="v1" allowedActions={['CLIENT_ACCEPT', 'OPEN_NEGOTIATION', 'CANCEL']} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ouvrir une négociation' }));
  const dialog = screen.getByRole('dialog', { name: 'Ouvrir une négociation' });
  const confirm = within(dialog).getByRole('button', { name: 'Ouvrir la négociation' });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Modifications demandées par le client'), 'Baisser le plafond');
  await userEvent.click(confirm);
  expect(await within(dialog).findByText('Transition refusée depuis ce statut.')).toBeInTheDocument();
  expect(api.find('POST', '/v1/contracts/k1/negotiate')[0]!.body).toEqual({ reason: 'Baisser le plafond' });
});

test('acceptation reçue hors application : version courante, justificatif obligatoire', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/acceptance': { acceptanceId: 'a1', status: 'ACCEPTED' } });
  wrap(<NegotiationActions contractId="k1" currentVersionId="v7" allowedActions={['CLIENT_ACCEPT', 'OPEN_NEGOTIATION']} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer une acceptation' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Nom de la personne qui accepte'), 'Jean Martin');
  await userEvent.type(within(dialog).getByLabelText('E-mail'), 'jean@client.fr');
  const submit = within(dialog).getByRole('button', { name: 'Enregistrer l’acceptation' });
  expect(submit).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Pièce justificative'), 'E-mail du 12/09, bon pour accord');
  await userEvent.click(submit);
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/acceptance')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/acceptance')[0]!.body).toEqual({
    versionId: 'v7', acceptedByName: 'Jean Martin', acceptedByEmail: 'jean@client.fr', evidenceNote: 'E-mail du 12/09, bon pour accord',
  });
});

test('DECLINED : rouvrir la négociation ; lecteur : aucune action', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/reopen-negotiation': { status: 'IN_NEGOTIATION' } });
  const { unmount } = wrap(<NegotiationActions contractId="k1" currentVersionId="v1" allowedActions={['REOPEN_NEGOTIATION', 'CANCEL']} me={READER} />);
  expect(screen.queryByRole('button', { name: 'Rouvrir la négociation' })).not.toBeInTheDocument();
  unmount();
  wrap(<NegotiationActions contractId="k1" currentVersionId="v1" allowedActions={['REOPEN_NEGOTIATION', 'CANCEL']} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Rouvrir la négociation' }));
  await userEvent.type(screen.getByLabelText('Motif de la reprise'), 'Le client a changé d’interlocuteur');
  await userEvent.click(screen.getByRole('button', { name: 'Rouvrir' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/reopen-negotiation')).toHaveLength(1));
});

test('historique des acceptations', async () => {
  routeFetch({
    'GET /v1/contracts/k1/acceptances': { items: [
      { id: 'a2', versionId: 'v7-aaaa-bbbb', method: 'PORTAL', acceptedByName: 'Nathalie', acceptedByEmail: 'n@client.fr', ip: '203.0.113.9', acceptedAt: '2026-09-20T10:00:00Z', evidenceNote: null, versionPdfSha256: null },
      { id: 'a1', versionId: 'v6-cccc', method: 'RECORDED_BY_STAFF', acceptedByName: 'Jean', acceptedByEmail: 'j@client.fr', ip: null, acceptedAt: '2026-09-01T10:00:00Z', evidenceNote: 'Courrier signé', versionPdfSha256: null },
    ] },
  });
  wrap(<AcceptancesBlock contractId="k1" currentVersionId="v7-aaaa-bbbb" />);
  expect(await screen.findByText('Depuis l’espace client')).toBeInTheDocument();
  expect(screen.getByText('Enregistrée par LSI')).toBeInTheDocument();
  expect(screen.getByText(/IP 203.0.113.9/)).toBeInTheDocument();
  expect(screen.getByText('(version courante)')).toBeInTheDocument();
  expect(screen.getByText('(version antérieure)')).toBeInTheDocument();
  expect(screen.getByText('Courrier signé')).toBeInTheDocument();
});
