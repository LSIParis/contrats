import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PendingValidationsPage } from '../features/proposals/pending-validations-page.js';
import { ToastProvider } from '../ui/toast.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const ITEMS = [
  { scope: 'LINE', key: 'serveur-supervise', label: 'Serveur supervisé', templateSlug: 'supervision', templateName: 'Supervision et sauvegarde', detail: { unit: 'serveur / mois', pricing: { dependsOn: 'engagement', byChoice: { '24': 4500, '36': 4000 } }, priceSource: 'Valeur indicative' } },
  { scope: 'RULE', key: 'minimum-mensuel', label: 'Complément minimum', templateSlug: 'supervision', templateName: 'Supervision et sauvegarde', detail: { amountCents: 9900, priceSource: null } },
  { scope: 'SECTION', key: 'niveaux-de-service', label: 'Niveaux de service', templateSlug: 'infogerance', templateName: 'Infogérance TPE-PME', detail: null },
];

function mount(roles: string[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let validated = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === '/v1/auth/me') return json({ userId: 'u', fullName: 'Admin', email: null, kind: 'INTERNAL', roles, customerId: null });
    if (url.endsWith('/validate')) {
      validated = true;
      return json({ items: ITEMS.slice(1), total: 2 });
    }
    return validated ? json({ items: ITEMS.slice(1), total: 2 }) : json({ items: ITEMS, total: 3 });
  }) as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter><PendingValidationsPage /></MemoryRouter></ToastProvider></QueryClientProvider>);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

test('liste les éléments par modèle et valide après confirmation', async () => {
  const calls = mount(['MSP_ADMIN']);
  expect(await screen.findByText('Supervision et sauvegarde (2)')).toBeInTheDocument();
  expect(screen.getByText('Infogérance TPE-PME (1)')).toBeInTheDocument();
  expect(screen.getByText(/99,00\s€ HT \/ mois/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Valider Serveur supervisé' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/journal d’audit/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Valider' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
  const post = calls.find((c) => c.url.endsWith('/validate'))!;
  expect(JSON.parse(String(post.init!.body))).toEqual({ templateSlug: 'supervision', scope: 'LINE', key: 'serveur-supervise' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Valider Serveur supervisé' })).not.toBeInTheDocument());
});

test('réservé à l’administrateur', async () => {
  mount(['ACCOUNT_MANAGER']);
  expect(await screen.findByText(/réservé aux administrateurs/)).toBeInTheDocument();
});
