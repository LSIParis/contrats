import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RenewalDecision } from '../features/lifecycle/renewal-decision.js';
import { TerminationPanel } from '../features/lifecycle/termination-panel.js';
import { LifecycleTimeline } from '../features/lifecycle/lifecycle-timeline.js';
import type { Me } from '../lib/queries.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const AM: Me = { userId: 'u1', fullName: 'Paul', email: 'p@lsi.fr', kind: 'INTERNAL', roles: ['ACCOUNT_MANAGER'], customerId: null, permissions: ['contracts.lifecycle'] };
const READER: Me = { ...AM, permissions: ['contracts.read'] };
const renewalProps = { contractId: 'k1', status: 'RENEWAL_DUE', endDate: '2026-12-31', renewalPeriodMonths: 12, allowedActions: ['RENEW_PERIOD', 'CLOSE_RENEWAL', 'MARK_RENEWED', 'EXPIRE', 'TERMINATE'] };

test('À renouveler : « Renouveler » avec la durée par défaut du contrat', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/renewal/renew': { status: 'ACTIVE', endDate: '2027-12-31' } });
  wrap(<RenewalDecision {...renewalProps} me={AM} />);
  expect(screen.getByText(/Renouvellement à décider : le terme de la période en cours est le 31\/12\/2026/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Renouveler' }));
  const dialog = screen.getByRole('dialog', { name: 'Renouveler pour une nouvelle période' });
  expect(within(dialog).getByText(/durée de reconduction du contrat \(12 mois\)/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmer le renouvellement' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/renewal/renew')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/renewal/renew')[0]!.body).toEqual({});
});

test('« Renouveler » avec une durée saisie ; durée obligatoire si le contrat n’en a pas', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/renewal/renew': { status: 'ACTIVE', endDate: '2027-06-30' } });
  wrap(<RenewalDecision {...renewalProps} renewalPeriodMonths={null} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Renouveler' }));
  const confirm = screen.getByRole('button', { name: 'Confirmer le renouvellement' });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/Durée de la nouvelle période/), '6');
  await userEvent.click(confirm);
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/renewal/renew')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/renewal/renew')[0]!.body).toEqual({ months: 6 });
});

test('« Ne pas renouveler » exige un motif ; un lecteur ne voit aucune action', async () => {
  const api = routeFetch({ 'POST /v1/contracts/k1/renewal/close': { status: 'ACTIVE' } });
  const { unmount } = wrap(<RenewalDecision {...renewalProps} me={READER} />);
  expect(screen.queryByRole('button', { name: 'Renouveler' })).not.toBeInTheDocument();
  unmount();
  wrap(<RenewalDecision {...renewalProps} me={AM} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ne pas renouveler' }));
  await userEvent.type(screen.getByLabelText('Motif du non-renouvellement'), 'Client parti chez un concurrent');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer le non-renouvellement' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/renewal/close')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/renewal/close')[0]!.body).toEqual({ reason: 'Client parti chez un concurrent' });
});

test('résiliation en cours : date d’effet, courrier PDF joint (multipart « letter »), retrait motivé', async () => {
  const api = routeFetch({
    'POST /v1/contracts/k1/termination-letter': { id: 'doc1', sha256: 'abc123' },
    'POST /v1/contracts/k1/withdraw-termination': { status: 'ACTIVE' },
  });
  wrap(<TerminationPanel contractId="k1" status="TERMINATION_PENDING" terminationEffectiveDate="2026-12-31" allowedActions={['COMPLETE_TERMINATION', 'WITHDRAW_TERMINATION']} me={AM} />);
  expect(screen.getByText('31/12/2026')).toBeInTheDocument();
  const input = screen.getByLabelText('Courrier de résiliation scanné (PDF)');
  await userEvent.upload(input, new File(['%PDF'], 'courrier.txt', { type: 'text/plain' }), { applyAccept: false });
  expect(screen.getByText('Le courrier de résiliation doit être un PDF.')).toBeInTheDocument();
  await userEvent.upload(input, new File(['%PDF-1.4'], 'courrier.pdf', { type: 'application/pdf' }));
  await userEvent.click(screen.getByRole('button', { name: 'Joindre le courrier' }));
  expect(await screen.findByText('abc123')).toBeInTheDocument();
  const sent = api.find('POST', '/v1/contracts/k1/termination-letter')[0]!.body as FormData;
  expect(sent).toBeInstanceOf(FormData);
  expect((sent.get('letter') as File).name).toBe('courrier.pdf');

  await userEvent.click(screen.getByRole('button', { name: 'Retirer la résiliation' }));
  await userEvent.type(screen.getByLabelText('Motif du retrait'), 'Accord trouvé');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer le retrait' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/withdraw-termination')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/withdraw-termination')[0]!.body).toEqual({ reason: 'Accord trouvé' });
});

test('journal du cycle de vie : événements v2 en français, du plus récent au plus ancien', async () => {
  routeFetch({ 'GET /v1/contracts/k1/lifecycle': { items: [
    { at: '2026-09-01T08:00:00Z', from: 'APPROVED', to: 'SENT_TO_CLIENT', event: 'SEND_TO_CLIENT', reason: null, actor: { id: 'u1', name: 'Paul' }, actorKind: 'INTERNAL' },
    { at: '2026-09-05T08:00:00Z', from: 'SENT_TO_CLIENT', to: 'IN_NEGOTIATION', event: 'OPEN_NEGOTIATION', reason: 'Plafond trop bas', actor: { id: 'u1', name: 'Paul' }, actorKind: 'INTERNAL' },
    { at: '2026-12-01T03:00:00Z', from: 'ACTIVE', to: 'RENEWAL_DUE', event: 'OPEN_RENEWAL', reason: null, actor: null, actorKind: 'SYSTEM' },
  ] } });
  wrap(<LifecycleTimeline contractId="k1" />);
  const list = await screen.findByRole('list', { name: 'Transitions du contrat' });
  const items = within(list).getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('Renouvellement à décider');
  expect(items[0]).toHaveTextContent('Système');
  expect(items[1]).toHaveTextContent('Négociation ouverte');
  expect(items[1]).toHaveTextContent('Motif : Plafond trop bas');
  expect(items[2]).toHaveTextContent('Envoyé au client');
  expect(items[2]).toHaveTextContent('Paul');
});
