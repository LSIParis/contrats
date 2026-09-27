import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace, TRACKING } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

async function openTab(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: new RegExp(`^${name}`) }));
  return user;
}

const SENT = () => detail({
  proposal: { status: 'VIEWED', expiresAt: '2026-10-31T22:59:59.999Z', sentAt: '2026-09-20T08:00:00Z' },
  version: { ...detail().version, lockedAt: '2026-09-20T08:00:00Z' },
});

test('destinataires : ajout depuis un contact du client, retrait avant envoi', async () => {
  const api = mountWorkspace({
    routes: {
      'GET /v1/customers/c-1': { customer: { id: 'c-1', name: 'Acme' }, contacts: [{ id: 'k-3', firstName: 'Chloé', lastName: 'Petit', email: 'chloe@acme.fr', jobTitle: 'DAF', isSignatory: true }] },
      'POST /v1/proposals/p-1/recipients': detail(),
      'DELETE /v1/proposals/p-1/recipients/r-2': {},
    },
  });
  const user = await openTab('Destinataires et envoi');
  const panel = await screen.findByRole('region', { name: 'Destinataires' });
  expect(within(panel).getByRole('row', { name: /Alice Martin/ })).toHaveTextContent('Signataire');
  await user.selectOptions(await within(panel).findByLabelText('Contact du client'), 'k-3');
  expect(within(panel).getByLabelText('E-mail')).toHaveValue('chloe@acme.fr');
  expect(within(panel).getByLabelText('Rôle')).toHaveValue('SIGNER');
  await user.click(within(panel).getByRole('button', { name: 'Ajouter le destinataire' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/recipients')[0]?.body).toEqual({
    contactId: 'k-3', fullName: 'Chloé Petit', email: 'chloe@acme.fr', jobTitle: 'DAF', role: 'SIGNER', signingOrder: 2,
  }));
  await user.click(within(panel).getByRole('button', { name: 'Retirer Bob Durand' }));
  await waitFor(() => expect(api.find('DELETE', '/v1/proposals/p-1/recipients/r-2')).toHaveLength(1));
});

test('après l’envoi : échéance, état des envois (erreur), renvoi individuel, relances planifiées désactivables', async () => {
  const api = mountWorkspace({
    detail: SENT(),
    routes: { 'POST /v1/proposals/p-1/resend': SENT(), 'PATCH /v1/proposals/p-1': SENT() },
  });
  const user = await openTab('Destinataires et envoi');
  const panel = await screen.findByRole('region', { name: 'Destinataires' });
  expect(within(panel).queryByRole('button', { name: 'Ajouter le destinataire' })).not.toBeInTheDocument();
  expect(within(panel).getByText(/Lien valable jusqu’au 01\/11\/2026|Lien valable jusqu’au 31\/10\/2026/)).toBeInTheDocument();
  const bob = await within(panel).findByRole('row', { name: /Bob Durand/ });
  expect(within(bob).getByText(/Échec : Boîte pleine/)).toBeInTheDocument();
  await user.click(within(bob).getByRole('button', { name: 'Renvoyer à Bob Durand' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/resend')[0]?.body).toEqual({ recipientId: 'r-2' }));
  const followUps = screen.getByRole('region', { name: 'Relances automatiques' });
  expect(within(followUps).getByText('Sans décision')).toBeInTheDocument();
  await user.click(within(followUps).getByRole('checkbox', { name: 'Relances automatiques activées' }));
  await waitFor(() => expect(api.find('PATCH', '/v1/proposals/p-1')[0]?.body).toEqual({ followUpsEnabled: false }));
});

test('suivi : bandeau RGPD, synthèse, lecture par section et chronologie par destinataire', async () => {
  mountWorkspace({ detail: SENT() });
  await openTab('Suivi');
  const panel = await screen.findByRole('region', { name: 'Suivi de lecture' });
  expect(within(panel).getByRole('note')).toHaveTextContent(/aucun traceur tiers/i);
  expect(within(panel).getByText('3 min 05 s')).toBeInTheDocument();
  const sections = within(panel).getByRole('table', { name: 'Lecture par section' });
  expect(within(sections).getByRole('row', { name: /Votre investissement/ })).toHaveTextContent('2 min 00 s');
  const alice = within(panel).getByRole('list', { name: 'Chronologie — Alice Martin' });
  expect(within(alice).getAllByRole('listitem')).toHaveLength(3);
  expect(within(alice).getByText(/Téléchargement du PDF/)).toBeInTheDocument();
  const bob = within(panel).getByRole('list', { name: 'Chronologie — Bob Durand' });
  expect(within(bob).getByText(/Nouveau lecteur/)).toBeInTheDocument();
  expect(within(panel).getByRole('list', { name: 'Historique des statuts' })).toHaveTextContent('Prête → Envoyée');
});

test('temps réel : un événement SSE de cette proposition recharge le suivi', async () => {
  const sources: FakeEventSource[] = [];
  class FakeEventSource {
    listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { sources.push(this); }
    addEventListener(t: string, f: (e: MessageEvent) => void) { (this.listeners[t] ??= []).push(f); }
    removeEventListener() {}
    close() {}
    emit(data: unknown) { for (const f of this.listeners.proposal ?? []) f(new MessageEvent('proposal', { data: JSON.stringify(data) })); }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  const api = mountWorkspace({ detail: SENT() });
  await openTab('Suivi');
  await screen.findByRole('region', { name: 'Suivi de lecture' });
  await waitFor(() => expect(sources.some((s) => s.url === '/v1/proposals/stream')).toBe(true));
  const before = api.find('GET', '/v1/proposals/p-1/tracking').length;
  act(() => { for (const s of sources) { s.onopen?.(); s.emit({ userId: 'u-1', proposalId: 'p-1', type: 'proposal.first_open', subject: 'Première ouverture de PROP-2026-0007', at: '2026-09-27T10:00:00Z' }); } });
  await waitFor(() => expect(api.find('GET', '/v1/proposals/p-1/tracking').length).toBeGreaterThan(before));
  expect(await screen.findByText('Première ouverture de PROP-2026-0007')).toBeInTheDocument();
  expect(screen.getByText('connecté')).toBeInTheDocument();
});

test('échanges : fil par section, réponse du commercial rattachée à la question', async () => {
  const api = mountWorkspace({
    detail: SENT(),
    routes: {
      'GET /v1/proposals/p-1/comments': { items: [{ id: 'm-1', parentId: null, sectionKey: 'investissement', authorKind: 'CLIENT', authorName: 'Alice Martin', body: 'La mise en service est-elle obligatoire ?', createdAt: '2026-09-22T09:00:00Z' }] },
      'POST /v1/proposals/p-1/comments': { id: 'm-2', parentId: 'm-1', sectionKey: 'investissement', authorKind: 'INTERNAL', authorName: 'Camille (LSI Maintenance)', body: 'Oui.', createdAt: '2026-09-22T10:00:00Z' },
    },
  });
  const user = await openTab('Échanges');
  const panel = await screen.findByRole('region', { name: 'Questions et commentaires' });
  const thread = await within(panel).findByRole('article', { name: /Alice Martin/ });
  expect(within(thread).getByText('Section : Votre investissement')).toBeInTheDocument();
  await user.click(within(thread).getByRole('button', { name: 'Répondre à Alice Martin' }));
  await user.type(within(thread).getByLabelText('Votre réponse'), 'Oui, elle est obligatoire.');
  await user.click(within(thread).getByRole('button', { name: 'Envoyer la réponse' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/comments')[0]?.body).toEqual({ body: 'Oui, elle est obligatoire.', parentId: 'm-1', sectionKey: 'investissement' }));
});

void TRACKING;
