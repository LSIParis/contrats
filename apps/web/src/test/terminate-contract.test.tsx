import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminateContract } from '../features/contracts/terminate-contract.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const props = { contractId: 'k1', customerName: 'ACME', noticePeriodDays: 30, roles: ['ACCOUNT_MANAGER'], allowedActions: ['TERMINATE'] };
const PREVIEW = { effectiveDate: '2026-12-31', deadlineMissed: false, noticeDeadline: '2026-10-31', currentPeriodEnd: '2026-12-31' };

test('rien si TERMINATE non autorisé', () => {
  wrap(<TerminateContract {...props} allowedActions={[]} />);
  expect(screen.queryByRole('button', { name: /Résilier/ })).not.toBeInTheDocument();
});

test('la confirmation exige le nom du client puis POST /terminate sans date (calculée par le serveur)', async () => {
  const api = routeFetch({
    'GET /v1/contracts/k1/termination-preview': PREVIEW,
    'POST /v1/contracts/k1/terminate': { status: 'TERMINATION_PENDING', effectiveDate: '2026-12-31', noticeRespected: true },
  });
  wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  expect(await screen.findByText('31/12/2026')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/Motif/), 'Fin de contrat');
  // bouton confirmer désactivé tant que le nom ne correspond pas
  const confirm = screen.getByRole('button', { name: /Confirmer la résiliation/ });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/terminate')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/terminate')[0]!.body).toEqual({ reason: 'Fin de contrat', initiatedBy: 'LSI' });
});

test('date limite de dénonciation dépassée : avertissement', async () => {
  routeFetch({ 'GET /v1/contracts/k1/termination-preview': { ...PREVIEW, effectiveDate: '2027-12-31', deadlineMissed: true } });
  wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  expect(await screen.findByText(/La date limite de dénonciation est dépassée/)).toBeInTheDocument();
  expect(screen.getByText('31/12/2027')).toBeInTheDocument();
});

test('date souhaitée antérieure : refusée au commercial, dérogation motivée pour l’administrateur', async () => {
  const api = routeFetch({
    'GET /v1/contracts/k1/termination-preview': PREVIEW,
    'POST /v1/contracts/k1/terminate': { status: 'TERMINATION_PENDING', effectiveDate: '2026-11-15', noticeRespected: false },
  });
  const { unmount } = wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  await screen.findByText('31/12/2026');
  await userEvent.type(screen.getByLabelText(/Date d’effet souhaitée/), '2026-11-15');
  expect(screen.getByText(/seul un administrateur peut déroger/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/^Motif/), 'x');
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  expect(screen.getByRole('button', { name: /Confirmer la résiliation/ })).toBeDisabled();
  unmount();

  wrap(<TerminateContract {...props} roles={['MSP_ADMIN']} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  await screen.findByText('31/12/2026');
  await userEvent.type(screen.getByLabelText(/Date d’effet souhaitée/), '2026-11-15');
  await userEvent.type(screen.getByLabelText(/^Motif/), 'Faute grave');
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  const confirm = screen.getByRole('button', { name: /Confirmer la résiliation/ });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/Justification de la dérogation/), 'Accord écrit du client');
  await userEvent.click(confirm);
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/terminate')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/terminate')[0]!.body).toEqual({
    reason: 'Faute grave', initiatedBy: 'LSI', effectiveDate: '2026-11-15', overrideReason: 'Accord écrit du client',
  });
});

test('refus serveur (règle métier) affiché', async () => {
  routeFetch({
    'GET /v1/contracts/k1/termination-preview': PREVIEW,
    'POST /v1/contracts/k1/terminate': [409, { code: 'RM-20', detail: 'Le préavis de 30 jours n’est pas respecté.' }],
  });
  wrap(<TerminateContract {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Résilier/ }));
  await userEvent.type(screen.getByLabelText(/^Motif/), 'x');
  await userEvent.type(screen.getByLabelText(/Tapez le nom du client/), 'ACME');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer la résiliation/ }));
  expect(await screen.findByText('Le préavis de 30 jours n’est pas respecté.')).toBeInTheDocument();
});
