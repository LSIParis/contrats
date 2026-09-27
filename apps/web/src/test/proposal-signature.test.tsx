import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

async function openPanel() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Signature et contrat' }));
  return { user, panel: await screen.findByRole('region', { name: 'Signature et conversion' }) };
}

const SIG = {
  id: 's-1', status: 'SENT', delivery: 'EMBEDDED', sentPdfSha256: 'b'.repeat(64), signedPdfSha256: null, auditTrailSha256: null,
  hashRelation: null, createdAt: '2026-09-25T09:00:00Z', errorMessage: null,
};

test('en signature : statut DocuSeal et empreinte du PDF envoyé', async () => {
  mountWorkspace({ detail: detail({ proposal: { status: 'PENDING_SIGNATURE', acceptedAt: '2026-09-25T09:00:00Z' }, signature: SIG }) });
  const { panel } = await openPanel();
  expect(within(panel).getByText('Envoyée en signature')).toBeInTheDocument();
  expect(within(panel).getByText('b'.repeat(64))).toBeInTheDocument();
});

test('acceptée, DocuSeal indisponible : erreur affichée et relance de l’envoi en signature', async () => {
  const d = detail({ proposal: { status: 'ACCEPTED' }, signature: { ...SIG, status: 'FAILED', errorMessage: 'DocuSeal indisponible (503)' }, allowedEvents: ['START_SIGNATURE', 'REVISE'] });
  const api = mountWorkspace({ detail: d, routes: { 'POST /v1/proposals/p-1/start-signature': { signatureRequestId: 's-2', embedSrc: null } } });
  const { user, panel } = await openPanel();
  expect(within(panel).getByText('DocuSeal indisponible (503)')).toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Relancer l’envoi en signature' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/start-signature')).toHaveLength(1));
});

test('signée, conversion en échec : erreur, lien vers la correspondance des contrats types, relance', async () => {
  const d = detail({
    proposal: { status: 'SIGNED', signedAt: '2026-09-26T09:00:00Z', conversionError: 'Contrat type « infogerance » introuvable ou non publié.' },
    signature: { ...SIG, status: 'COMPLETED', signedPdfSha256: 'c'.repeat(64), auditTrailSha256: 'd'.repeat(64), hashRelation: 'DERIVED' },
    allowedEvents: ['CONVERT'],
  });
  const api = mountWorkspace({ detail: d, routes: { 'POST /v1/proposals/p-1/convert': [404, { detail: 'Contrat type « infogerance » introuvable ou non publié.' }] } });
  const { user, panel } = await openPanel();
  const alert = within(panel).getByRole('alert');
  expect(alert).toHaveTextContent('Contrat type « infogerance » introuvable');
  expect(within(panel).getByRole('link', { name: 'Associer les contrats types' })).toHaveAttribute('href', '/proposal-admin/contract-templates');
  await user.click(within(panel).getByRole('button', { name: 'Relancer la conversion' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/convert')).toHaveLength(1));
  expect(await within(panel).findAllByText(/introuvable ou non publié/)).not.toHaveLength(0);
});

test('convertie : lien vers le contrat généré', async () => {
  const user = userEvent.setup();
  mountWorkspace({ detail: detail({ proposal: { status: 'CONVERTED', contractId: 'ct-1', convertedAt: '2026-09-26T10:00:00Z' } }) });
  const { panel } = await openPanel();
  await user.click(within(panel).getByRole('link', { name: 'Ouvrir le contrat généré' }));
  expect(await screen.findByText('Fiche du contrat')).toBeInTheDocument();
});

test('un lecteur ne peut pas relancer la conversion', async () => {
  const d = detail({ proposal: { status: 'SIGNED', conversionError: 'x' }, allowedEvents: ['CONVERT'] });
  mountWorkspace({ roles: ['READER'], detail: d });
  const { panel } = await openPanel();
  expect(within(panel).queryByRole('button', { name: 'Relancer la conversion' })).not.toBeInTheDocument();
});
