import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage, fromInput, toInput } from '../features/settings/settings-page.js';
import { AppShell } from '../shell/app-shell.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SETTINGS = {
  'ai.provider': 'perplexity', 'ai.model': null, 'ai.preset': null, 'ai.monthlyBudgetUsd': null,
  'alerts.thresholdsDays': [90, 60, 30, 7], 'pricing.rounding': 'HALF_AWAY_FROM_ZERO',
  'pricing.overrideApprovalThresholdPercent': 10, 'signature.defaultOrder': 'CLIENT_FIRST',
  'signature.expireDays': 30, 'retention.yearsAfterEnd': 5,
};

type Call = { method: string; url: string; body: unknown };

function setup(roles: string[], putSetting?: (body: unknown) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.includes('/v1/auth/me')) return json({ userId: 'u1', fullName: 'Admin', roles });
    if (url === '/v1/feature-flags') {
      return json({
        flags: { 'contrats.ai.enabled': false, 'contrats.docuseal.enabled': true },
        descriptions: { 'contrats.ai.enabled': 'Rédaction assistée par IA.', 'contrats.docuseal.enabled': 'Signature DocuSeal.' },
      });
    }
    if (method === 'PUT' && url.startsWith('/v1/admin/feature-flags/')) return json({ key: decodeURIComponent(url.split('/').pop()!), ...body });
    if (url === '/v1/admin/settings') return json({ settings: SETTINGS });
    if (method === 'PUT' && url.startsWith('/v1/admin/settings/')) return putSetting?.(body) ?? json({ key: 'x', value: body.value });
    if (url.includes('/v1/notifications')) return json({ items: [], unreadCount: 0 });
    return new Response('', { status: 404 });
  }));
  return calls;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><SettingsPage /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

test('conversion des saisies : liste, nombre, texte nullable', () => {
  expect(fromInput('90, 60 ,7', { type: 'list' })).toEqual({ value: [90, 60, 7] });
  expect(fromInput('90, abc', { type: 'list' })).toHaveProperty('error');
  expect(fromInput('', { type: 'number', nullable: true })).toEqual({ value: null });
  expect(fromInput('12,5', { type: 'number' })).toEqual({ value: 12.5 });
  expect(fromInput('', { type: 'text', nullable: true })).toEqual({ value: null });
  expect(toInput([90, 60], { type: 'list' })).toBe('90, 60');
});

test('drapeaux : description affichée, bascule → PUT { enabled }', async () => {
  const user = userEvent.setup();
  const calls = setup(['MSP_ADMIN']);
  renderPage();
  const sw = await screen.findByRole('switch', { name: /contrats\.ai\.enabled/ });
  expect(sw).not.toBeChecked();
  expect(sw).toHaveAccessibleDescription('Rédaction assistée par IA.');
  expect(screen.getByRole('switch', { name: /contrats\.docuseal\.enabled/ })).toBeChecked();
  await user.click(sw);
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  const put = calls.find((c) => c.method === 'PUT')!;
  expect(put.url).toBe('/v1/admin/feature-flags/contrats.ai.enabled');
  expect(put.body).toEqual({ enabled: true });
});

test('paramètres : seule la valeur modifiée est envoyée ; l’erreur de validation serveur est affichée sous le champ', async () => {
  const user = userEvent.setup();
  const calls = setup(['MSP_ADMIN'], () =>
    json({ statusCode: 400, message: ['alerts.thresholdsDays.1 : Too small: expected number to be >0'] }, 400));
  renderPage();
  const input = await screen.findByLabelText(/Seuils d’alerte/);
  await waitFor(() => expect(input).toHaveValue('90, 60, 30, 7'));
  await user.clear(input);
  await user.type(input, '90, 0');
  await user.click(screen.getByRole('button', { name: /Enregistrer les paramètres/ }));
  expect(await screen.findByText(/alerts\.thresholdsDays\.1 : Too small/)).toBeInTheDocument();
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveFocus();
  const puts = calls.filter((c) => c.method === 'PUT');
  expect(puts).toHaveLength(1);
  expect(puts[0]!.url).toBe('/v1/admin/settings/alerts.thresholdsDays');
  expect(puts[0]!.body).toEqual({ value: [90, 0] });
});

test('paramètres : un texte saisi est envoyé tel quel', async () => {
  const user = userEvent.setup();
  const calls = setup(['MSP_ADMIN']);
  renderPage();
  const model = await screen.findByLabelText(/Modèle IA/);
  await user.type(model, 'sonar-pro');
  await user.click(screen.getByRole('button', { name: /Enregistrer les paramètres/ }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ value: 'sonar-pro' });
});

test('page refusée hors administrateur', async () => {
  setup(['ACCOUNT_MANAGER']);
  renderPage();
  expect(await screen.findByText('Accès réservé aux administrateurs.')).toBeInTheDocument();
});

test('menu : « Paramètres » visible pour MSP_ADMIN, masqué sinon', async () => {
  for (const [roles, visible] of [[['MSP_ADMIN'], true], [['LEGAL_REVIEWER'], false]] as const) {
    setup([...roles]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes><Route element={<AppShell />}><Route path="/dashboard" element={<p>x</p>} /></Route></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument());
    if (visible) expect(screen.getByRole('link', { name: 'Paramètres' })).toHaveAttribute('href', '/settings');
    else expect(screen.queryByRole('link', { name: 'Paramètres' })).not.toBeInTheDocument();
    unmount();
  }
});
