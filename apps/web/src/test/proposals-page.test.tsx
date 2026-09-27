import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ProposalsPage } from '../features/proposals/proposals-page.js';
import { renderWithClient } from './api-mock.js';
import { routeFetch } from './fetch-router.js';

afterEach(() => vi.unstubAllGlobals());

const ME = (roles: string[]) => ({ userId: 'u-1', fullName: 'Camille Commerciale', roles });

const ITEMS = [
  {
    id: 'p-1', number: 'PROP-2026-0001', title: 'Infogérance — Acme', status: 'VIEWED', customerId: 'c-1', ownerUserId: 'u-1',
    expiresAt: '2026-10-31T22:59:59.999Z', oneTimeCents: '50000', monthlyCents: '151500', commitmentTotalCents: '5454000',
    commitmentMonths: 36, winProbability: 60, sentAt: '2026-09-20T08:00:00Z', lastActivityAt: '2026-09-26T09:00:00Z',
    contractId: null, updatedAt: '2026-09-26T09:00:00Z', customer: { name: 'Acme', commercialStatus: 'PROSPECT' }, owner: { fullName: 'Camille Commerciale' },
  },
  {
    id: 'p-2', number: 'PROP-2026-0002', title: 'Sauvegarde — Beta', status: 'IN_INTERNAL_REVIEW', customerId: 'c-2', ownerUserId: 'u-2',
    expiresAt: null, oneTimeCents: null, monthlyCents: '29475', commitmentTotalCents: '353700', commitmentMonths: 12,
    winProbability: null, sentAt: null, lastActivityAt: null, contractId: null, updatedAt: '2026-09-25T09:00:00Z',
    customer: { name: 'Beta', commercialStatus: 'CLIENT' }, owner: { fullName: 'Dominique' },
  },
];
const CUSTOMERS = { items: [{ id: 'c-1', name: 'Acme', siren: null, country: 'FR', status: 'ACTIVE', contractCount: 0 }, { id: 'c-2', name: 'Beta', siren: null, country: 'FR', status: 'ACTIVE', contractCount: 1 }] };
const TEMPLATES = {
  items: [
    { id: 't-1', slug: 'infogerance', name: 'Infogérance TPE-PME', description: null, acceptanceMode: 'DOCUSEAL_SIGNATURE', contractTemplateSlug: 'infogerance', signedProposalIsContract: false, seedVersion: 1, userModifiedAt: null, archivedAt: null, pendingValidations: 1 },
    { id: 't-2', slug: 'ancien', name: 'Ancien modèle', description: null, acceptanceMode: 'CLICK_ACCEPT', contractTemplateSlug: null, signedProposalIsContract: false, seedVersion: 1, userModifiedAt: null, archivedAt: '2026-01-01T00:00:00Z', pendingValidations: 0 },
  ],
};

function mount(roles = ['ACCOUNT_MANAGER'], extra: Record<string, unknown> = {}) {
  const api = routeFetch({
    'GET /v1/auth/me': ME(roles),
    'GET /v1/proposals': { items: ITEMS },
    'GET /v1/customers': CUSTOMERS,
    'GET /v1/proposal-admin/templates': TEMPLATES,
    'GET /v1/customers/c-1': {
      customer: { id: 'c-1', name: 'Acme' },
      contacts: [
        { id: 'k-1', firstName: 'Alice', lastName: 'Martin', email: 'alice@acme.fr', jobTitle: 'DG', isPrimary: true, isSignatory: true },
        { id: 'k-2', firstName: 'Bob', lastName: 'Durand', email: 'bob@acme.fr', jobTitle: 'DSI', isPrimary: false, isSignatory: false },
      ],
    },
    'POST /v1/proposals': { proposal: { id: 'p-new' } },
    ...extra,
  });
  renderWithClient(
    <Routes>
      <Route path="/proposals" element={<ProposalsPage />} />
      <Route path="/proposals/:id" element={<p>Espace de la proposition</p>} />
    </Routes>,
    ['/proposals'],
  );
  return api;
}

test('liste : statuts en français, montants formatés par le serveur, client prospect signalé', async () => {
  mount();
  const table = await screen.findByRole('table', { name: 'Propositions commerciales' });
  const row = within(table).getByRole('row', { name: /PROP-2026-0001/ });
  expect(within(row).getByText('Consultée')).toBeInTheDocument();
  expect(within(row).getByText('Prospect')).toBeInTheDocument();
  expect(within(row).getByText('1 515,00 €')).toBeInTheDocument();
  expect(within(row).getByText('54 540,00 €')).toBeInTheDocument();
  expect(within(row).getByRole('link', { name: 'PROP-2026-0001' })).toHaveAttribute('href', '/proposals/p-1');
  expect(within(table).getByText('En revue interne')).toBeInTheDocument();
});

test('filtres : statut, client et « mes propositions » passent dans la requête', async () => {
  const user = userEvent.setup();
  const api = mount();
  await screen.findByRole('table', { name: 'Propositions commerciales' });
  await user.selectOptions(screen.getByLabelText('Statut'), 'SENT');
  await user.selectOptions(screen.getByLabelText('Client'), 'c-2');
  await user.click(screen.getByLabelText('Mes propositions'));
  await waitFor(() => expect(api.calls.some((c) => c.url === '/v1/proposals?status=SENT&customerId=c-2&mine=true')).toBe(true));
});

test('création : client, modèle (hors archivés), mode d’acceptation, contacts → POST puis ouverture de l’espace', async () => {
  const user = userEvent.setup();
  const api = mount();
  await user.click(await screen.findByRole('button', { name: 'Nouvelle proposition' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle proposition' });
  await user.selectOptions(within(dialog).getByLabelText('Client ou prospect'), 'c-1');
  const tpl = within(dialog).getByLabelText('Modèle');
  await waitFor(() => expect(within(tpl).getByRole('option', { name: 'Infogérance TPE-PME' })).toBeInTheDocument());
  expect(within(tpl).queryByRole('option', { name: 'Ancien modèle' })).not.toBeInTheDocument();
  await user.selectOptions(tpl, 'infogerance');
  await user.selectOptions(within(dialog).getByLabelText('Mode d’acceptation'), 'CLICK_ACCEPT');
  await user.click(await within(dialog).findByRole('checkbox', { name: /Alice Martin/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Créer la proposition' }));
  await screen.findByText('Espace de la proposition');
  expect(api.find('POST', '/v1/proposals')[0]!.body).toEqual({
    customerId: 'c-1', templateSlug: 'infogerance', acceptanceMode: 'CLICK_ACCEPT', contactIds: ['k-1'],
  });
});

test('création pour un nouveau prospect : le client est créé d’abord, puis la proposition vierge', async () => {
  const user = userEvent.setup();
  const api = mount(['ACCOUNT_MANAGER'], { 'POST /v1/customers': { id: 'c-9', name: 'Gamma' } });
  await user.click(await screen.findByRole('button', { name: 'Nouvelle proposition' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle proposition' });
  await user.click(within(dialog).getByRole('radio', { name: 'Nouveau prospect' }));
  await user.type(within(dialog).getByLabelText('Raison sociale'), 'Gamma');
  await user.click(within(dialog).getByRole('button', { name: 'Créer la proposition' }));
  await screen.findByText('Espace de la proposition');
  expect(api.find('POST', '/v1/customers')[0]!.body).toEqual({ name: 'Gamma', commercialStatus: 'PROSPECT' });
  expect(api.find('POST', '/v1/proposals')[0]!.body).toEqual({ customerId: 'c-9' });
});

test('erreur serveur (detail) affichée dans la boîte de création', async () => {
  const user = userEvent.setup();
  mount(['ACCOUNT_MANAGER'], { 'POST /v1/proposals': [404, { code: 'NOT_FOUND', detail: 'Modèle de proposition introuvable' }] });
  await user.click(await screen.findByRole('button', { name: 'Nouvelle proposition' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle proposition' });
  await user.selectOptions(within(dialog).getByLabelText('Client ou prospect'), 'c-2');
  await user.click(within(dialog).getByRole('button', { name: 'Créer la proposition' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Modèle de proposition introuvable');
});

test('lecteur : pas de bouton de création', async () => {
  mount(['READER']);
  await screen.findByRole('table', { name: 'Propositions commerciales' });
  expect(screen.queryByRole('button', { name: 'Nouvelle proposition' })).not.toBeInTheDocument();
});

test('module désactivé : message du serveur', async () => {
  mount(['ACCOUNT_MANAGER'], {
    'GET /v1/proposals': [404, { code: 'PROPOSALS_DISABLED', detail: 'Le module Propositions n’est pas activé pour ce tenant (contrats.proposals.enabled).' }],
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('n’est pas activé');
});
