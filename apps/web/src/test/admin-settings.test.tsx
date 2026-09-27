import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiClientsPage } from '../features/settings/api-clients-page.js';
import { WebhooksPage } from '../features/settings/webhooks-page.js';
import { AiUsageCard, SETTING_DEFS } from '../features/settings/settings-page.js';
import { AppShell } from '../shell/app-shell.js';
import { json, mockApi, problem, renderWithClient, type Route as ApiRoute } from './api-mock.js';

afterEach(() => vi.unstubAllGlobals());

const FLAGS = (api: boolean) => ({
  flags: { 'contrats.ai.enabled': true, 'contrats.docuseal.enabled': true, 'contrats.api.enabled': api },
  descriptions: { 'contrats.ai.enabled': 'IA', 'contrats.docuseal.enabled': 'DocuSeal', 'contrats.api.enabled': 'API publique' },
});

// ---------------------------------------------------------------------------
// Paramètres : clés de tarification, usage IA
// ---------------------------------------------------------------------------

test('paramètres : toutes les clés pricing.* du tenant sont éditables', () => {
  const keys = SETTING_DEFS.map((d) => d.key);
  expect(keys).toEqual(expect.arrayContaining([
    'ai.provider', 'ai.model', 'ai.preset', 'ai.monthlyBudgetUsd', 'alerts.thresholdsDays',
    'pricing.rounding', 'pricing.overrideApprovalThresholdPercent', 'pricing.unitPriceScale', 'pricing.indexLookup',
    'signature.defaultOrder', 'signature.expireDays', 'retention.yearsAfterEnd',
  ]));
});

test('usage IA : mois choisi, totaux, jauge de budget, lignes par opération', async () => {
  const user = userEvent.setup();
  const calls = mockApi([
    ['GET', '/v1/ai/availability', () => ({ enabled: true, provider: 'perplexity', configured: true, budgetUsd: 50, spentUsd: 40, available: true })],
    ['GET', /^\/v1\/admin\/ai\/usage/, (_b, url) => ({
      month: url.includes('2026-08') ? '2026-08' : '2026-09', totalCostUsd: 40, totalCalls: 12, budgetUsd: 50,
      lines: [
        { operation: 'draft', provider: 'perplexity', status: 'OK', calls: 10, inputTokens: 12000, outputTokens: 34000, costUsd: 38.5 },
        { operation: 'rephrase', provider: 'perplexity', status: 'TIMEOUT', calls: 2, inputTokens: 0, outputTokens: 0, costUsd: 1.5 },
      ],
    })],
  ]);
  renderWithClient(<AiUsageCard />);
  const card = await screen.findByRole('region', { name: 'Usage de l’IA' });
  const gauge = await within(card).findByRole('progressbar', { name: 'Budget IA consommé' });
  expect(gauge).toHaveAttribute('aria-valuenow', '80');
  expect(within(card).getByText(/Fournisseur : Perplexity — clé configurée — disponible/)).toBeInTheDocument();
  const table = within(card).getByRole('table', { name: 'Appels IA du mois' });
  expect(within(table).getByText('Rédaction')).toBeInTheDocument();
  expect(within(table).getByText('Délai dépassé')).toBeInTheDocument();
  const month = within(card).getByLabelText('Mois (AAAA-MM)');
  await user.clear(month);
  await user.type(month, '2026-08');
  await user.click(within(card).getByRole('button', { name: 'Afficher' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/v1/admin/ai/usage?month=2026-08')).toBe(true));
});

// ---------------------------------------------------------------------------
// Clients d'API
// ---------------------------------------------------------------------------

const CLIENT = {
  id: '44444444-4444-4444-8444-444444444444', name: 'Client Help', description: 'RMM', keyPrefix: 'abcdefghijkl',
  scopes: ['contracts:read', 'pricing:read'], rateLimitPerMinute: 120, active: true, revokedAt: null,
  lastUsedAt: '2026-09-20T08:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const KEY = 'ctr_mnopqrstuvwx_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

function apiRoutes(extra: ApiRoute[] = [], apiEnabled = true): ApiRoute[] {
  return [
    ...extra,
    ['GET', '/v1/admin/api-clients', () => [CLIENT]],
    ['GET', '/v1/feature-flags', () => FLAGS(apiEnabled)],
  ];
}

test('clients d’API : liste (préfixe, scopes, débit, dernier usage) et lien vers la documentation', async () => {
  mockApi(apiRoutes([], false));
  renderWithClient(<ApiClientsPage />);
  const table = await screen.findByRole('table', { name: 'Clients de l’API publique' });
  expect(within(table).getByText('ctr_abcdefghijkl_…')).toBeInTheDocument();
  expect(within(table).getByText('contracts:read')).toBeInTheDocument();
  expect(within(table).getByText('120 / min')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Documentation de l’API/ })).toHaveAttribute('href', '/api/v1/docs');
  expect(await screen.findByText(/L’API publique est désactivée/)).toBeInTheDocument();
});

test('création : clé affichée une seule fois, copiable, avertissement', async () => {
  const user = userEvent.setup();
  const calls = mockApi(apiRoutes([['POST', '/v1/admin/api-clients', (b) => ({ ...CLIENT, ...(b as object), id: 'n1', keyPrefix: 'mnopqrstuvwx', apiKey: KEY })]]));
  renderWithClient(<ApiClientsPage />);
  await user.click(await screen.findByRole('button', { name: 'Nouveau client d’API' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouveau client d’API' });
  await user.type(within(dialog).getByLabelText('Nom'), 'Facturation');
  await user.click(within(dialog).getByRole('checkbox', { name: /pricing:quote/ }));
  await user.clear(within(dialog).getByLabelText('Débit maximal (requêtes par minute)'));
  await user.type(within(dialog).getByLabelText('Débit maximal (requêtes par minute)'), '60');
  await user.click(within(dialog).getByRole('button', { name: 'Créer le client' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Facturation', scopes: ['pricing:quote'], rateLimitPerMinute: 60 });
  const secret = await screen.findByRole('dialog', { name: 'Clé d’API — affichée une seule fois' });
  expect(within(secret).getByLabelText('Clé d’API')).toHaveValue(KEY);
  expect(within(secret).getByText(/ne sera plus jamais affichée/)).toBeInTheDocument();
  await user.click(within(secret).getByRole('button', { name: 'Copier' }));
  expect(await navigator.clipboard.readText()).toBe(KEY);
  expect(within(secret).getByText('Copiée dans le presse-papiers.')).toBeInTheDocument();
  await user.click(within(secret).getByRole('button', { name: 'J’ai conservé la clé' }));
  expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
});

test('création : aucun scope → refusé avant l’envoi', async () => {
  const user = userEvent.setup();
  mockApi(apiRoutes());
  renderWithClient(<ApiClientsPage />);
  await user.click(await screen.findByRole('button', { name: 'Nouveau client d’API' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouveau client d’API' });
  await user.type(within(dialog).getByLabelText('Nom'), 'X');
  expect(within(dialog).getByRole('button', { name: 'Créer le client' })).toBeDisabled();
});

test('rotation (clé affichée une fois) et révocation confirmées', async () => {
  const user = userEvent.setup();
  const calls = mockApi(apiRoutes([
    ['POST', `/v1/admin/api-clients/${CLIENT.id}/rotate`, () => ({ ...CLIENT, apiKey: KEY })],
    ['POST', `/v1/admin/api-clients/${CLIENT.id}/revoke`, () => ({ ...CLIENT, active: false })],
  ]));
  renderWithClient(<ApiClientsPage />);
  await user.click(await screen.findByRole('button', { name: 'Nouvelle clé pour Client Help' }));
  const rot = await screen.findByRole('dialog', { name: 'Nouvelle clé pour Client Help' });
  expect(within(rot).getByText(/L’ancienne clé cesse immédiatement de fonctionner/)).toBeInTheDocument();
  await user.click(within(rot).getByRole('button', { name: 'Générer une nouvelle clé' }));
  const secret = await screen.findByRole('dialog', { name: 'Clé d’API — affichée une seule fois' });
  expect(within(secret).getByLabelText('Clé d’API')).toHaveValue(KEY);
  await user.click(within(secret).getByRole('button', { name: 'J’ai conservé la clé' }));

  await user.click(screen.getByRole('button', { name: 'Révoquer Client Help' }));
  const rev = await screen.findByRole('dialog', { name: 'Révoquer Client Help' });
  await user.click(within(rev).getByRole('button', { name: 'Révoquer' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(true));
});

test('clients d’API : réservé aux administrateurs', async () => {
  mockApi(apiRoutes(), { userId: 'u', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ApiClientsPage />);
  expect(await screen.findByText('Accès réservé aux administrateurs.')).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Webhooks sortants
// ---------------------------------------------------------------------------

const SUB = {
  id: '55555555-5555-4555-8555-555555555555', url: 'https://erp.example.com/hooks/contrats', description: 'ERP',
  eventTypes: ['contract.signed', 'pricing.revised'], secretHint: 'a1b2', active: true, consecutiveFailures: 0,
  disabledAt: null, disabledReason: null, createdByUserId: 'u-admin', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const EVENT_TYPES = ['contract.activated', 'contract.signed', 'contract.renewal_due', 'contract.renewed', 'contract.terminated', 'pricing.revised'];
const DELIVERY = {
  id: '66666666-6666-4666-8666-666666666666', status: 'DEAD', attempt: 6, nextAttemptAt: null, responseStatus: 500, responseMs: 812,
  lastError: 'HTTP 500', deliveredAt: null, createdAt: '2026-09-26T10:00:00Z',
  event: { id: 'e1', type: 'contract.signed', occurredAt: '2026-09-26T10:00:00Z', resourceId: 'k1' },
};

function hookRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ['GET', '/v1/admin/webhooks', () => ({ subscriptions: [SUB], eventTypes: EVENT_TYPES })],
    ['GET', new RegExp(`^/v1/admin/webhooks/${SUB.id}/deliveries`), () => ({ deliveries: [DELIVERY] })],
  ];
}

test('webhooks : liste et création (secret affiché une fois)', async () => {
  const user = userEvent.setup();
  const calls = mockApi(hookRoutes([['POST', '/v1/admin/webhooks', (b) => ({ ...SUB, ...(b as object), id: 'w2', secret: 'whsec_TOPSECRET' })]]));
  renderWithClient(<WebhooksPage />);
  const table = await screen.findByRole('table', { name: 'Abonnements aux webhooks' });
  expect(within(table).getByText('https://erp.example.com/hooks/contrats')).toBeInTheDocument();
  expect(within(table).getByText('Contrat signé')).toBeInTheDocument();
  expect(within(table).getByText('…a1b2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Nouvel abonnement' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvel abonnement' });
  await user.type(within(dialog).getByLabelText('URL de destination (https)'), 'https://crm.example.com/in');
  await user.click(within(dialog).getByRole('checkbox', { name: /Contrat résilié/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Créer l’abonnement' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ url: 'https://crm.example.com/in', eventTypes: ['contract.terminated'] });
  const secret = await screen.findByRole('dialog', { name: 'Secret de signature — affiché une seule fois' });
  expect(within(secret).getByLabelText('Secret HMAC')).toHaveValue('whsec_TOPSECRET');
});

test('webhooks : URL refusée par le serveur → détail affiché', async () => {
  const user = userEvent.setup();
  mockApi(hookRoutes([['POST', '/v1/admin/webhooks', () => problem(400, 'URL refusée : hôte privé')]]));
  renderWithClient(<WebhooksPage />);
  await user.click(await screen.findByRole('button', { name: 'Nouvel abonnement' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvel abonnement' });
  await user.type(within(dialog).getByLabelText('URL de destination (https)'), 'https://10.0.0.1/x');
  await user.click(within(dialog).getByRole('checkbox', { name: /Contrat signé/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Créer l’abonnement' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('URL refusée : hôte privé');
});

test('webhooks : test, désactivation, rotation du secret, livraisons et relivraison', async () => {
  const user = userEvent.setup();
  const calls = mockApi(hookRoutes([
    ['POST', `/v1/admin/webhooks/${SUB.id}/test`, () => json({ deliveryId: 'd9', outcome: 'DELIVERED' })],
    ['POST', `/v1/admin/webhooks/${SUB.id}/disable`, () => ({ ...SUB, active: false })],
    ['POST', `/v1/admin/webhooks/${SUB.id}/rotate-secret`, () => ({ ...SUB, secretHint: 'zz99', secret: 'whsec_NEW' })],
    ['POST', `/v1/admin/webhook-deliveries/${DELIVERY.id}/redeliver`, () => ({ deliveryId: DELIVERY.id, outcome: 'FAILED' })],
  ]));
  renderWithClient(<WebhooksPage />);
  const table = await screen.findByRole('table', { name: 'Abonnements aux webhooks' });
  await user.click(within(table).getByRole('button', { name: `Tester ${SUB.url}` }));
  expect(await screen.findByText('Ping : livré.')).toBeInTheDocument();

  await user.click(within(table).getByRole('button', { name: `Désactiver ${SUB.url}` }));
  const dis = await screen.findByRole('dialog', { name: 'Désactiver l’abonnement' });
  await user.click(within(dis).getByRole('button', { name: 'Désactiver' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/disable'))).toBe(true));

  await user.click(within(table).getByRole('button', { name: `Nouveau secret pour ${SUB.url}` }));
  const rot = await screen.findByRole('dialog', { name: 'Nouveau secret de signature' });
  await user.click(within(rot).getByRole('button', { name: 'Générer un nouveau secret' }));
  const secret = await screen.findByRole('dialog', { name: 'Secret de signature — affiché une seule fois' });
  expect(within(secret).getByLabelText('Secret HMAC')).toHaveValue('whsec_NEW');
  await user.click(within(secret).getByRole('button', { name: 'J’ai conservé le secret' }));

  await user.click(within(table).getByRole('button', { name: `Livraisons de ${SUB.url}` }));
  const region = await screen.findByRole('region', { name: `Livraisons — ${SUB.url}` });
  const deliveries = await within(region).findByRole('table', { name: 'Livraisons' });
  expect(within(deliveries).getByText('Abandonnée')).toBeInTheDocument();
  expect(within(deliveries).getByText('HTTP 500')).toBeInTheDocument();
  await user.selectOptions(within(region).getByLabelText('Statut'), 'DEAD');
  await waitFor(() => expect(calls.some((c) => c.url.includes('/deliveries?status=DEAD'))).toBe(true));
  await user.click(within(deliveries).getByRole('button', { name: 'Relivrer' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/redeliver'))).toBe(true));
  expect(await screen.findByText('Relivraison : échec (nouvelle tentative programmée).')).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

test('menu : « Tarification » pour qui peut simuler, masqué pour un lecteur', async () => {
  for (const [roles, visible] of [[['ACCOUNT_MANAGER'], true], [['READER'], false]] as const) {
    mockApi([], { userId: 'u1', fullName: 'Utilisateur', roles: [...roles] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes><Route element={<AppShell />}><Route path="/dashboard" element={<p>x</p>} /></Route></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Utilisateur')).toBeInTheDocument());
    if (visible) expect(screen.getByRole('link', { name: 'Tarification' })).toHaveAttribute('href', '/pricing');
    else expect(screen.queryByRole('link', { name: 'Tarification' })).not.toBeInTheDocument();
    unmount();
  }
});
