import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProposalPublicPage } from '../features/proposals/public/proposal-public-page.js';

const TOKEN = 'A'.repeat(43);
const bucket = (ht: number) => ({ htCents: ht, vatCents: Math.round(ht / 5), ttcCents: ht + Math.round(ht / 5) });
const QUOTE = {
  choices: { engagement: '24' }, quantities: { poste: 10 }, selectedOptions: [], commitmentMonths: 24,
  lines: [{ key: 'poste', label: 'Poste de travail', group: 'RECURRING', recurrence: 'MONTHLY', unit: 'poste / mois', quantity: 10, unitPriceCents: 2500, totalHtCents: 25000, priceStatus: 'VALIDATED', priceFrom: false }],
  infoLines: [{ key: 'regie', label: 'Intervention à distance', group: 'OUT_OF_SCOPE', recurrence: 'INFO', unit: 'heure', quantity: 0, unitPriceCents: 9500, totalHtCents: 0, priceStatus: 'VALIDATED', priceFrom: false }],
  totals: { oneTime: bucket(35000), monthly: bucket(25000), quarterly: bucket(0), yearly: bucket(0), commitment: bucket(600000) },
  errors: [], blockingValidations: [],
};
function view(over: Record<string, unknown> = {}) {
  return {
    proposal: { number: 'PROP-2026-0007', title: 'Proposition d’infogérance', status: 'SENT', statusLabel: 'Envoyée', expiresAt: '2026-10-31T21:59:59.999Z', acceptanceMode: 'DOCUSEAL_SIGNATURE', sensitive: false, versionNumber: 1 },
    recipient: { fullName: 'Jeanne Dupont', role: 'SIGNER' },
    expired: false, superseded: false,
    trackingNotice: 'Suivi de lecture sans traceur tiers.',
    otp: { required: false, verified: false },
    content: {
      sections: [
        { key: 'contexte', title: 'Votre contexte', kind: 'TEXT', html: '<p>Parc de 10 postes.</p>', aiPendingReview: false },
        { key: 'investissement', title: 'Votre investissement', kind: 'PRICING', html: '', aiPendingReview: false },
        { key: 'signature', title: 'Acceptation et signature', kind: 'SIGNATURE', html: '', aiPendingReview: false },
      ],
      pricing: {
        definition: {
          vatRatePercent: 20,
          choices: [{ key: 'engagement', label: 'Durée d’engagement', editableByClient: true, options: [{ value: '24', label: '24 mois', description: null, default: true }, { value: '36', label: '36 mois', description: null, default: false }] }],
          lines: [{ key: 'poste', label: 'Poste de travail', description: null, kind: 'REQUIRED', unit: 'poste / mois', recurrence: 'MONTHLY', group: 'RECURRING', priceFrom: false, pricing: {}, quantity: { min: 1, max: 500, maxFrom: null, linkedTo: null, editableByClient: true } }],
        },
        selection: { choices: {}, quantities: {}, selectedOptions: [] },
        quote: QUOTE,
      },
    },
    comments: [],
    actions: { canConfigure: true, canComment: true, canDecline: true, canAccept: true, acceptRequiresOtp: false },
    signature: null,
    ...over,
  };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function mount(fetchImpl: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return fetchImpl(url, init);
  }) as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/p/${TOKEN}`]}>
        <Routes><Route path="/p/:token" element={<ProposalPublicPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

test('affiche les sections, les totaux du serveur, la bannière de suivi et envoie OPENED', async () => {
  const calls = mount((url) => (url.endsWith('/events') ? json({ recorded: 1 }, 202) : json(view())));
  expect(await screen.findByRole('heading', { name: 'Proposition d’infogérance' })).toBeInTheDocument();
  expect(screen.getByText('Parc de 10 postes.')).toBeInTheDocument();
  expect(screen.getByText('Suivi de lecture sans traceur tiers.')).toBeInTheDocument();
  expect(screen.getByText(/250,00\s€ HT/)).toBeInTheDocument();
  expect(screen.getByText(/Tarifs hors forfait/)).toBeInTheDocument();
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/events'))).toBe(true));
  const ev = calls.find((c) => c.url.endsWith('/events'))!;
  expect(JSON.parse(String(ev.init!.body)).events).toEqual([{ type: 'OPENED' }]);
});

test('changer d’option appelle le serveur et affiche SES totaux (aucun calcul local)', async () => {
  const serverQuote = { ...QUOTE, choices: { engagement: '36' }, totals: { ...QUOTE.totals, monthly: bucket(22500) } };
  const calls = mount((url, init) => {
    if (url.endsWith('/selection')) return json({ selection: { choices: { engagement: '36' }, quantities: {}, selectedOptions: [] }, quote: serverQuote });
    if (url.endsWith('/events')) return json({}, 202);
    return json(view());
  });
  fireEvent.click(await screen.findByRole('radio', { name: /36 mois/ }));
  await waitFor(() => expect(screen.getByText(/225,00\s€ HT/)).toBeInTheDocument());
  const put = calls.find((c) => c.url.endsWith('/selection'))!;
  expect(put.init!.method).toBe('PUT');
  expect(JSON.parse(String(put.init!.body))).toEqual({ choices: { engagement: '36' } });
});

test('proposition expirée : message dédié, pas d’acceptation', async () => {
  mount((url) => (url.endsWith('/events') ? json({}, 202) : json(view({
    expired: true,
    proposal: { ...view().proposal, status: 'EXPIRED', statusLabel: 'Expirée' },
    actions: { canConfigure: false, canComment: false, canDecline: false, canAccept: false, acceptRequiresOtp: false },
  }))));
  expect(await screen.findByText(/Cette proposition a expiré/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Accepter/ })).not.toBeInTheDocument();
});

test('proposition sensible : contenu absent tant que le code n’est pas vérifié', async () => {
  mount(() => json(view({ content: null, actions: null, otp: { required: true, verified: false } })));
  expect(await screen.findByRole('button', { name: /Recevoir un code/ })).toBeInTheDocument();
  expect(screen.queryByText('Parc de 10 postes.')).not.toBeInTheDocument();
});

test('lien révoqué : message explicite', async () => {
  mount(() => json({ code: 'LINK_REVOKED', detail: 'x' }, 410));
  expect(await screen.findByText(/n’est plus valable/)).toBeInTheDocument();
});

test('acceptation : consentement exigé puis envoyé', async () => {
  const calls = mount((url) => {
    if (url.endsWith('/accept')) return json({ status: 'PENDING_SIGNATURE', signature: { signatureRequestId: 's1', embedSrc: 'https://signe.example.test/s/abc' } });
    if (url.endsWith('/events')) return json({}, 202);
    return json(view());
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Accepter et signer' }));
  fireEvent.change(screen.getByLabelText('Fonction'), { target: { value: 'Gérante' } });
  fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'jeanne@dupont.fr' } });
  const submit = screen.getByRole('button', { name: /passer à la signature/ });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /je les accepte/ }));
  fireEvent.click(submit);
  expect(await screen.findByTitle(/Signature électronique/)).toHaveAttribute('src', 'https://signe.example.test/s/abc');
  const post = calls.find((c) => c.url.endsWith('/accept'))!;
  expect(JSON.parse(String(post.init!.body))).toEqual({ fullName: 'Jeanne Dupont', jobTitle: 'Gérante', email: 'jeanne@dupont.fr', consent: true });
});

test('lecteur : ni acceptation ni refus', async () => {
  mount((url) => (url.endsWith('/events') ? json({}, 202) : json(view({ recipient: { fullName: 'Paul', role: 'READER' } }))));
  expect(await screen.findByText(/en lecture/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Décliner' })).not.toBeInTheDocument();
});
