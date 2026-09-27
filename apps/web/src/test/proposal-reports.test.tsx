import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ProposalDashboardPage, ProposalPipelinePage } from '../features/proposals/reports/proposal-reports-pages.js';
import { renderWithClient } from './api-mock.js';
import { routeFetch } from './fetch-router.js';

afterEach(() => vi.unstubAllGlobals());

const OPEN = ['DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED', 'PENDING_SIGNATURE'];
const ITEM = (over: Record<string, unknown>) => ({
  id: 'p-1', number: 'PROP-2026-0001', title: 'Infogérance — Acme', status: 'VIEWED', customer: { id: 'c-1', name: 'Acme' },
  owner: { id: 'u-1', name: 'Camille' }, template: { id: 't-1', name: 'Infogérance TPE-PME', slug: 'infogerance' },
  monthlyCents: '151500', amountCents: '5454000', probability: 40, weightedCents: '2181600', expiresAt: '2026-10-31T22:59:59Z', ...over,
});
const PIPELINE = {
  columns: OPEN.map((status) => (status === 'VIEWED'
    ? { status, count: 1, amountCents: '5454000', weightedCents: '2181600' }
    : status === 'DRAFT' ? { status, count: 1, amountCents: '353700', weightedCents: '35370' } : { status, count: 0, amountCents: '0', weightedCents: '0' })),
  items: [ITEM({}), ITEM({ id: 'p-2', number: 'PROP-2026-0002', title: 'Sauvegarde — Beta', status: 'DRAFT', customer: { id: 'c-2', name: 'Beta' }, owner: { id: 'u-2', name: 'Dominique' }, template: null, monthlyCents: '29475', amountCents: '353700', probability: 10, weightedCents: '35370', expiresAt: null })],
  totals: { count: 2, amountCents: '5807700', weightedCents: '2216970' },
};
const TEMPLATES = { items: [{ id: 't-1', slug: 'infogerance', name: 'Infogérance TPE-PME', description: null, acceptanceMode: 'DOCUSEAL_SIGNATURE', contractTemplateSlug: 'infogerance', signedProposalIsContract: false, seedVersion: 1, userModifiedAt: null, archivedAt: null, pendingValidations: 0 }] };

function mountPipeline(extra: Record<string, unknown> = {}) {
  const api = routeFetch({
    'GET /v1/auth/me': { userId: 'u-1', fullName: 'Camille', roles: ['ACCOUNT_MANAGER'] },
    'GET /v1/proposal-reports/pipeline': PIPELINE,
    'GET /v1/proposal-admin/templates': TEMPLATES,
    ...extra,
  });
  renderWithClient(
    <Routes>
      <Route path="/proposals/pipeline" element={<ProposalPipelinePage />} />
      <Route path="/proposals/:id" element={<p>Espace de la proposition</p>} />
    </Routes>,
    ['/proposals/pipeline'],
  );
  return api;
}

test('pipeline kanban : une colonne par statut ouvert, totaux, cartes cliquables', async () => {
  const user = userEvent.setup();
  mountPipeline();
  const board = await screen.findByRole('region', { name: 'Pipeline en colonnes' });
  expect(within(board).getAllByRole('list')).toHaveLength(8);
  const viewed = within(board).getByRole('list', { name: /^Consultée/ });
  expect(viewed.getAttribute('aria-label')!.replace(/\s/g, ' ')).toBe('Consultée — 1 proposition, 54 540,00 €, pondéré 21 816,00 €');
  const card = within(viewed).getByRole('listitem');
  expect(card).toHaveTextContent('Acme');
  expect(card).toHaveTextContent('Camille');
  expect(card).toHaveTextContent('40 %');
  expect(card).toHaveTextContent('31/10/2026');
  expect(screen.getByRole('region', { name: 'Totaux du pipeline' })).toHaveTextContent('58 077,00 €');
  await user.click(within(card).getByRole('link', { name: /PROP-2026-0001/ }));
  expect(await screen.findByText('Espace de la proposition')).toBeInTheDocument();
});

test('pipeline : vue liste et filtres commercial / modèle', async () => {
  const user = userEvent.setup();
  const api = mountPipeline();
  await screen.findByRole('region', { name: 'Pipeline en colonnes' });
  await user.click(screen.getByRole('radio', { name: 'Liste' }));
  const table = screen.getByRole('table', { name: 'Pipeline des propositions' });
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(within(table).getByRole('row', { name: /PROP-2026-0002/ })).toHaveTextContent('Brouillon');
  await user.selectOptions(screen.getByLabelText('Commercial'), 'u-2');
  await user.selectOptions(screen.getByLabelText('Modèle'), 't-1');
  await waitFor(() => expect(api.calls.some((c) => c.url === '/v1/proposal-reports/pipeline?ownerUserId=u-2&templateId=t-1')).toBe(true));
});

test('pipeline : module désactivé', async () => {
  mountPipeline({ 'GET /v1/proposal-reports/pipeline': [404, { code: 'PROPOSALS_DISABLED', detail: 'Le module Propositions n’est pas activé pour ce tenant.' }] });
  expect(await screen.findByRole('alert')).toHaveTextContent('n’est pas activé');
});

const DASHBOARD = {
  period: { from: '2025-09-28', to: '2026-09-27' }, sent: 10, won: 4, lost: 3, open: 3, conversionRatePercent: 40, decidedConversionRatePercent: 57.1,
  averageDaysSentToSigned: 12.5, signedRecurringMonthlyCents: '612000', signedOneTimeCents: '150000',
  byTemplate: [{ key: 't-1', label: 'Infogérance TPE-PME', sent: 6, won: 3, conversionRatePercent: 50, wonMonthlyCents: '454500' }, { key: 'SANS_MODELE', label: 'Sans modèle', sent: 4, won: 1, conversionRatePercent: 25, wonMonthlyCents: '157500' }],
  byOwner: [{ key: 'u-1', label: 'Camille', sent: 10, won: 4, conversionRatePercent: 40, wonMonthlyCents: '612000' }],
  mostReadSections: [{ sectionKey: 'investissement', opens: 25, averageSeconds: 95 }],
  declineReasons: [{ code: 'PRICE', count: 2 }, { code: 'NON_PRECISE', count: 1 }],
  mostChosenOptions: [{ code: 'serveur', count: 3 }],
};

function mountDashboard(extra: Record<string, unknown> = {}) {
  const api = routeFetch({
    'GET /v1/auth/me': { userId: 'u-1', fullName: 'Camille', roles: ['ACCOUNT_MANAGER'] },
    'GET /v1/proposal-reports/dashboard': DASHBOARD,
    ...extra,
  });
  renderWithClient(<Routes><Route path="/proposals/dashboard" element={<ProposalDashboardPage />} /></Routes>, ['/proposals/dashboard']);
  return api;
}

test('tableau de bord : indicateurs, rapport par modèle, par commercial, sections, refus, options', async () => {
  mountDashboard();
  const kpis = await screen.findByRole('region', { name: 'Indicateurs clés' });
  expect(within(kpis).getByText('40 %')).toBeInTheDocument();
  expect(within(kpis).getByText('57,1 %')).toBeInTheDocument();
  expect(within(kpis).getByText('12,5 jours')).toBeInTheDocument();
  expect(within(kpis).getByText('6 120,00 €')).toBeInTheDocument();
  const byTemplate = screen.getByRole('table', { name: 'Conversion par modèle' });
  expect(within(byTemplate).getByRole('row', { name: /Infogérance TPE-PME/ })).toHaveTextContent('50 %');
  expect(within(byTemplate).getByRole('row', { name: /Infogérance TPE-PME/ })).toHaveTextContent('4 545,00 €');
  expect(screen.getByRole('table', { name: 'Conversion par commercial' })).toHaveTextContent('Camille');
  expect(screen.getByRole('table', { name: 'Sections les plus lues' })).toHaveTextContent('1 min 35 s');
  const declines = screen.getByRole('table', { name: 'Motifs de refus' });
  expect(declines).toHaveTextContent('Prix');
  expect(declines).toHaveTextContent('Non précisé');
  expect(screen.getByRole('table', { name: 'Options les plus retenues' })).toHaveTextContent('serveur');
});

test('tableau de bord : période appliquée et export CSV avec les mêmes bornes', async () => {
  const user = userEvent.setup();
  const api = mountDashboard();
  await screen.findByRole('region', { name: 'Indicateurs clés' });
  expect(screen.getByRole('link', { name: 'Exporter en CSV' })).toHaveAttribute('href', '/v1/proposal-reports/dashboard.csv');
  await user.type(screen.getByLabelText('Du'), '2026-01-01');
  await user.type(screen.getByLabelText('Au'), '2026-06-30');
  await user.click(screen.getByRole('button', { name: 'Appliquer' }));
  await waitFor(() => expect(api.calls.some((c) => c.url === '/v1/proposal-reports/dashboard?from=2026-01-01&to=2026-06-30')).toBe(true));
  expect(screen.getByRole('link', { name: 'Exporter en CSV' })).toHaveAttribute('href', '/v1/proposal-reports/dashboard.csv?from=2026-01-01&to=2026-06-30');
});

test('tableau de bord : période invalide, detail du serveur', async () => {
  mountDashboard({ 'GET /v1/proposal-reports/dashboard': [400, { code: 'INVALID_RANGE', detail: 'Période invalide (du ≤ au, trois ans au plus).' }] });
  expect(await screen.findByRole('alert')).toHaveTextContent('Période invalide');
});
