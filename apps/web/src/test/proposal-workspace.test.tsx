import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

test('en-tête : numéro, statut, client, version, CGV, aperçu et PDF', async () => {
  mountWorkspace();
  expect(await screen.findByRole('heading', { level: 1, name: /PROP-2026-0007/ })).toBeInTheDocument();
  const header = screen.getByRole('region', { name: 'Proposition PROP-2026-0007' });
  expect(within(header).getByText('Brouillon')).toBeInTheDocument();
  expect(within(header).getByText('Acme')).toBeInTheDocument();
  expect(within(header).getByText(/Version 1/)).toBeInTheDocument();
  expect(within(header).getByText(/CGV v3 — CGV 2026/)).toBeInTheDocument();
  expect(within(header).getByRole('link', { name: 'Télécharger le PDF' })).toHaveAttribute('href', '/v1/proposals/p-1/pdf');
});

test('brouillon non prêt : aucune transition, points bloquants listés', async () => {
  mountWorkspace();
  await screen.findByRole('heading', { level: 1, name: /PROP-2026-0007/ });
  const actions = screen.getByRole('group', { name: 'Actions sur la proposition' });
  expect(within(actions).queryByRole('button', { name: 'Marquer prête' })).not.toBeInTheDocument();
  const issues = screen.getByRole('region', { name: 'Points bloquants avant envoi' });
  expect(within(issues).getByText('Section « Votre contexte » à compléter.')).toBeInTheDocument();
  expect(within(issues).getByRole('link', { name: 'Prix à valider' })).toHaveAttribute('href', '/proposal-admin/pending');
});

test('seules les transitions permises par l’API sont proposées ; « Marquer prête » appelle mark-ready', async () => {
  const user = userEvent.setup();
  const d = detail({ allowedEvents: ['SUBMIT_FOR_REVIEW', 'MARK_READY'], readiness: { issues: [], reviewReasons: [], counters: {} } });
  const api = mountWorkspace({ detail: d, routes: { 'POST /v1/proposals/p-1/mark-ready': detail({ proposal: { status: 'READY' }, allowedEvents: ['SEND', 'REVISE'] }) } });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  expect(within(actions).getByRole('button', { name: 'Soumettre en revue interne' })).toBeInTheDocument();
  expect(within(actions).queryByRole('button', { name: 'Envoyer au client' })).not.toBeInTheDocument();
  await user.click(within(actions).getByRole('button', { name: 'Marquer prête' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/mark-ready')).toHaveLength(1));
  expect(await within(actions).findByRole('button', { name: 'Envoyer au client' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Proposition PROP-2026-0007' })).toHaveTextContent('Prête');
});

test('revue interne : le valideur valide ou demande des modifications (motif obligatoire)', async () => {
  const user = userEvent.setup();
  const d = detail({ proposal: { status: 'IN_INTERNAL_REVIEW', reviewRequired: true }, allowedEvents: ['APPROVE_REVIEW', 'REJECT_REVIEW'], readiness: { issues: [], reviewReasons: ['Remise « X » de 15 % (seuil 10 %).'], counters: {} } });
  const api = mountWorkspace({ roles: ['LEGAL_REVIEWER'], detail: d, routes: { 'POST /v1/proposals/p-1/reject-review': detail() } });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  expect(screen.getByText('Remise « X » de 15 % (seuil 10 %).')).toBeInTheDocument();
  expect(within(actions).getByRole('button', { name: 'Valider la revue' })).toBeInTheDocument();
  await user.click(within(actions).getByRole('button', { name: 'Demander des modifications' }));
  const dialog = await screen.findByRole('dialog', { name: 'Demander des modifications' });
  const confirm = within(dialog).getByRole('button', { name: 'Renvoyer en brouillon' });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByLabelText('Motif'), 'Remise trop forte');
  await user.click(confirm);
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/reject-review')[0]?.body).toEqual({ reason: 'Remise trop forte' }));
});

test('revue interne : un commercial ne voit pas les boutons du valideur', async () => {
  const d = detail({ proposal: { status: 'IN_INTERNAL_REVIEW' }, allowedEvents: ['APPROVE_REVIEW', 'REJECT_REVIEW'] });
  mountWorkspace({ roles: ['ACCOUNT_MANAGER'], detail: d });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  expect(within(actions).queryByRole('button', { name: 'Valider la revue' })).not.toBeInTheDocument();
});

test('expirée : réactivation avec nouvelle date et motif', async () => {
  const user = userEvent.setup();
  const d = detail({ proposal: { status: 'EXPIRED', expiresAt: '2026-09-01T21:59:59Z' }, allowedEvents: ['REACTIVATE'] });
  const api = mountWorkspace({ detail: d, routes: { 'POST /v1/proposals/p-1/reactivate': detail({ proposal: { status: 'READY' } }) } });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  await user.click(within(actions).getByRole('button', { name: 'Réactiver' }));
  const dialog = await screen.findByRole('dialog', { name: 'Réactiver la proposition' });
  await user.type(within(dialog).getByLabelText('Motif'), 'Client relancé');
  await user.type(within(dialog).getByLabelText('Nouvelle échéance'), '2026-12-31');
  await user.click(within(dialog).getByRole('button', { name: 'Réactiver' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/reactivate')[0]?.body).toEqual({ reason: 'Client relancé', expiresOn: '2026-12-31' }));
});

test('erreur serveur : le detail est affiché', async () => {
  const user = userEvent.setup();
  const d = detail({ proposal: { status: 'READY' }, allowedEvents: ['SEND', 'REVISE'] });
  mountWorkspace({ detail: d, routes: { 'POST /v1/proposals/p-1/send': [409, { code: 'PROPOSAL_NOT_READY', detail: 'La proposition n’est plus prête à partir.' }] } });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  await user.click(within(actions).getByRole('button', { name: 'Envoyer au client' }));
  const dialog = await screen.findByRole('dialog', { name: 'Envoyer la proposition' });
  await user.click(within(dialog).getByRole('button', { name: 'Envoyer' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('La proposition n’est plus prête à partir.');
});

test('lecteur : aucune action d’écriture', async () => {
  const d = detail({ proposal: { status: 'READY' }, allowedEvents: ['SEND', 'REVISE'] });
  mountWorkspace({ roles: ['READER'], detail: d });
  const actions = await screen.findByRole('group', { name: 'Actions sur la proposition' });
  expect(within(actions).queryByRole('button')).not.toBeInTheDocument();
});

test('aperçu HTML rendu par le serveur, bureau ou mobile', async () => {
  const user = userEvent.setup();
  mountWorkspace({ routes: { 'GET /v1/proposals/p-1/preview': { html: '<!doctype html><html><body><h1>Aperçu</h1></body></html>' } } });
  await user.click(await screen.findByRole('button', { name: 'Aperçu' }));
  const dialog = await screen.findByRole('dialog', { name: 'Aperçu de la proposition' });
  const frame = await within(dialog).findByTitle('Aperçu de la proposition PROP-2026-0007');
  expect(frame.getAttribute('srcdoc')).toContain('<h1>Aperçu</h1>');
  expect(frame).toHaveAttribute('sandbox', '');
  await user.click(within(dialog).getByRole('radio', { name: 'Mobile' }));
  expect(frame.style.width).toBe('390px');
});
