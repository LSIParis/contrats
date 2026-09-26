import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  ContractDeadlines, UpcomingDeadlinesWidget, daysUntil, localIsoDay, remainingText, urgency,
} from '../features/deadlines/deadlines.js';
import { deadlineKindLabel } from '../lib/labels.js';

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${localIsoDay(d)}T00:00:00.000Z`;
};
const deadline = (id: string, kind: string, days: number) => ({
  id, contractId: 'k1', customerId: 'c1', kind, dueDate: inDays(days), details: null,
  contract: { reference: 'LSI-2026-0001', title: 'Maintenance', status: 'ACTIVE' },
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

test('libellés français de chaque nature d’échéance', () => {
  expect(deadlineKindLabel('PERIOD_END')).toBe('Fin de période');
  expect(deadlineKindLabel('NOTICE_DEADLINE')).toBe('Date limite de dénonciation');
  expect(deadlineKindLabel('RENEWAL_DECISION')).toBe('Décision de renouvellement');
  expect(deadlineKindLabel('CHATEL_NOTICE')).toBe('Information loi Chatel');
  expect(deadlineKindLabel('PRICE_REVISION')).toBe('Révision tarifaire');
  expect(deadlineKindLabel('TERMINATION_EFFECTIVE')).toBe('Prise d’effet de la résiliation');
});

test('urgence : ≤ 7 j danger, ≤ 30 j avertissement, toujours avec un texte', () => {
  expect(urgency(0)).toEqual({ tone: 'danger', label: 'Urgent' });
  expect(urgency(7)).toEqual({ tone: 'danger', label: 'Urgent' });
  expect(urgency(-2)).toEqual({ tone: 'danger', label: 'Dépassée' });
  expect(urgency(8)).toEqual({ tone: 'warn', label: 'Proche' });
  expect(urgency(30)).toEqual({ tone: 'warn', label: 'Proche' });
  expect(urgency(31)).toEqual({ tone: 'neutral', label: 'À venir' });
  expect(remainingText(0)).toBe('Aujourd’hui');
  expect(remainingText(1)).toBe('Demain');
  expect(remainingText(12)).toBe('Dans 12 jours');
  expect(remainingText(-3)).toBe('Dépassée de 3 jours');
  expect(daysUntil('2026-10-10', new Date(2026, 9, 1, 23, 30))).toBe(9);
});

test('widget « Échéances à venir » : fenêtre de 90 jours, libellés, délai et urgence en texte', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ items: [
      deadline('d1', 'NOTICE_DEADLINE', 3),
      deadline('d2', 'PERIOD_END', 20),
      deadline('d3', 'CHATEL_NOTICE', 60),
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  wrap(<UpcomingDeadlinesWidget />);
  await waitFor(() => expect(screen.getByText('Date limite de dénonciation')).toBeInTheDocument());
  const today = new Date();
  const to = new Date(today.getTime() + 90 * 86_400_000);
  expect(urls[0]).toBe(`/v1/deadlines?from=${localIsoDay(today)}&to=${localIsoDay(to)}`);
  expect(screen.getByRole('heading', { name: 'Échéances à venir (90 jours)' })).toBeInTheDocument();
  expect(screen.getByText('Urgent · Dans 3 jours')).toBeInTheDocument();
  expect(screen.getByText('Proche · Dans 20 jours')).toBeInTheDocument();
  expect(screen.getByText('À venir · Dans 60 jours')).toBeInTheDocument();
  expect(screen.getByText('Fin de période')).toBeInTheDocument();
  expect(screen.getByText('Information loi Chatel')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'LSI-2026-0001' })[0]).toHaveAttribute('href', '/contracts/k1');
  expect(screen.getAllByText('Actif').length).toBe(3); // StatusBadge
});

test('échéances d’un contrat : état vide explicite', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  wrap(<ContractDeadlines contractId="k1" />);
  expect(await screen.findByText('Aucune échéance.')).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/v1/contracts/k1/deadlines');
});
