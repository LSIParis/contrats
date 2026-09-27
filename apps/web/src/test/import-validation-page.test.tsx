import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ImportValidationPage } from '../features/imports/import-validation-page.js';
import type { ImportView } from '../features/imports/import-mapping.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const field = (value: unknown, confidence: number, excerpt = 'extrait') => ({
  value, confidence, evidence: { excerpt, offset: 0 }, method: 'RULES',
});

function makeView(over: Partial<ImportView> = {}): ImportView {
  return {
    contract: {
      id: 'k1', reference: 'IMP-2026-0001', title: 'Contrat Dupont', status: 'IMPORTED_PENDING_VALIDATION',
      category: 'MAINTENANCE', customerId: 'c1', startDate: null, endDate: null, signedAt: null,
      noticePeriodDays: null, noticePeriodMonths: null, renewalMode: 'NONE', renewalPeriodMonths: null,
      amountCents: null, billingFrequency: 'MONTHLY',
    },
    origin: 'LEGACY_IMPORT',
    signatureMode: 'EXTERNAL_WET_SIGNATURE',
    original: {
      id: 'd1', filename: 'dupont-2019.pdf', contentType: 'application/pdf', sizeBytes: 1000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      createdAt: '2026-09-01T10:00:00Z', uploadedByUserId: 'u-importer',
    },
    ocr: { status: 'DONE', attempts: 1, pages: 4, error: null, searchablePdf: { id: 'o1', sizeBytes: 2000, sha256: 'ff' } },
    extraction: {
      dateEffet: field('2026-01-01', 0.92, 'prend effet le 1er janvier 2026'),
      dureeMois: field(12, 0.85, 'durée de douze mois'),
      preavis: field({ quantite: 3, unite: 'MOIS' }, 0.4, 'préavis de trois mois'),
      reconduction: field('TACITE', 0.7),
      montantMensuelHtCentimes: field(150_000, 0.9),
      indiceRevision: field('SYNTEC', 0.8, 'indice SYNTEC'),
    },
    extractionMethod: 'RULES',
    validated: null,
    ...over,
  };
}

type Call = { url: string; method: string; body: unknown };

function setup(roles: string[], view: ImportView, onValidate?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/v1/auth/me')) return json({ userId: 'u-me', fullName: 'Moi', roles });
    if (url.endsWith('/import/validate')) return onValidate?.() ?? json({ id: 'k1', status: 'ACTIVE', deadlinesCreated: 3 });
    if (url.endsWith('/import/retry-ocr')) return json({ ocrStatus: 'PENDING' });
    if (url.endsWith('/v1/contracts/k1/import')) return json(view);
    return new Response('', { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contracts/k1/import']}>
        <Routes>
          <Route path="/contracts/:id/import" element={<ImportValidationPage />} />
          <Route path="/contracts/:id" element={<p>Fiche du contrat</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

test('pré-remplit les champs depuis la proposition (durée → terme, préavis en mois) avec confiance et preuve', async () => {
  setup(['LEGAL_REVIEWER'], makeView());
  expect(await screen.findByLabelText(/Date d’effet/)).toHaveValue('2026-01-01');
  expect(screen.getByLabelText(/Date de fin/)).toHaveValue('2026-12-31');
  expect(screen.getByText(/Calculé : date d’effet \+ 12 mois − 1 jour/)).toBeInTheDocument();
  expect(screen.getByLabelText('Préavis')).toHaveValue(3);
  expect(screen.getByLabelText('Unité du préavis')).toHaveValue('MOIS');
  expect(screen.getByLabelText('Reconduction')).toHaveValue('TACIT');
  expect(screen.getByLabelText(/Durée de reconduction/)).toHaveValue(12);
  expect(screen.getByLabelText(/Montant HT/)).toHaveValue('1500,00');
  // Confiance : pourcentage ET mot, pas la couleur seule.
  expect(screen.getAllByText('Confiance élevée : 92 %').length).toBeGreaterThan(0);
  expect(screen.getByText('Confiance faible : 40 %')).toBeInTheDocument();
  expect(screen.getByText(/prend effet le 1er janvier 2026/)).toBeInTheDocument();
  // Indice de révision : information en lecture seule.
  expect(screen.getByText('SYNTEC')).toBeInTheDocument();
});

test('affiche l’origine hors plateforme, l’empreinte SHA-256, l’importateur et la date', async () => {
  setup(['LEGAL_REVIEWER'], makeView());
  expect(await screen.findByText(/Contrat signé hors plateforme — aucune nouvelle signature ne sera demandée/)).toBeInTheDocument();
  expect(screen.getByText('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBeInTheDocument();
  expect(screen.getByText('LEGACY_IMPORT')).toBeInTheDocument();
  expect(screen.getByText('EXTERNAL_WET_SIGNATURE')).toBeInTheDocument();
  expect(screen.getByText(/utilisateur u-import, le/)).toBeInTheDocument();
  // Document à gauche : original affiché, bascule vers la copie OCR.
  expect(screen.getByTitle(/Document original : dupont-2019.pdf/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Copie OCR recherchable' }));
  expect(screen.getByTitle(/Copie OCR recherchable de dupont-2019.pdf/)).toHaveAttribute('src', '/v1/contracts/k1/import/ocr.pdf');
});

test('le bouton « Valider l’import » est réservé aux rôles imports.validate', async () => {
  setup(['ACCOUNT_MANAGER'], makeView());
  expect(await screen.findByText(/Validation réservée au juriste\/valideur/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Valider l’import/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Date d’effet/)).toBeDisabled();
});

test.each([['MSP_ADMIN'], ['LEGAL_REVIEWER']])('%s voit le bouton de validation', async (role) => {
  setup([role], makeView());
  expect(await screen.findByRole('button', { name: /Valider l’import/ })).toBeEnabled();
  expect(screen.queryByText(/Validation réservée/)).not.toBeInTheDocument();
});

test('envoie le corps attendu par ValidateImportSchema puis ouvre l’onglet Échéances', async () => {
  const user = userEvent.setup();
  const calls = setup(['LEGAL_REVIEWER'], makeView());
  await screen.findByRole('button', { name: /Valider l’import/ });
  await user.type(screen.getByLabelText('Commentaire du valideur'), 'Conforme à l’original');
  await user.click(screen.getByRole('button', { name: /Valider l’import/ }));
  await waitFor(() => expect(screen.getByText('Fiche du contrat')).toBeInTheDocument());
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/import/validate'));
  expect(post?.url).toBe('/v1/contracts/k1/import/validate');
  expect(post?.body).toEqual({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    renewalMode: 'TACIT',
    renewalPeriodMonths: 12,
    noticePeriodMonths: 3,
    amountCents: 150_000,
    billingFrequency: 'MONTHLY',
    title: 'Contrat Dupont',
    category: 'MAINTENANCE',
    note: 'Conforme à l’original',
  });
});

test('refus local : sans date d’effet, aucun envoi et le focus va au champ en erreur', async () => {
  const user = userEvent.setup();
  const calls = setup(['LEGAL_REVIEWER'], makeView({ extraction: null }));
  await screen.findByRole('button', { name: /Valider l’import/ });
  await user.click(screen.getByRole('button', { name: /Valider l’import/ }));
  expect(screen.getByText('La date d’effet est obligatoire.')).toBeInTheDocument();
  expect(screen.getByLabelText(/Date d’effet/)).toHaveFocus();
  expect(calls.some((c) => c.url.endsWith('/import/validate'))).toBe(false);
});

test('erreur serveur affichée en alerte', async () => {
  const user = userEvent.setup();
  setup(['LEGAL_REVIEWER'], makeView(), () => json({ message: 'Ce contrat est au statut ACTIVE.' }, 409));
  await user.click(await screen.findByRole('button', { name: /Valider l’import/ }));
  expect(await screen.findByText('Ce contrat est au statut ACTIVE.')).toHaveAttribute('role', 'alert');
});

test('OCR en échec : bouton « Relancer l’OCR » pour contracts.import, qui relance', async () => {
  const user = userEvent.setup();
  const calls = setup(['ACCOUNT_MANAGER'], makeView({
    ocr: { status: 'FAILED', attempts: 3, pages: null, error: 'Tesseract indisponible', searchablePdf: null },
  }));
  expect(await screen.findByText(/OCR en échec : Tesseract indisponible/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Relancer l’OCR' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/contracts/k1/import/retry-ocr')).toBe(true));
  // Pas de copie OCR : la bascule est désactivée.
  expect(screen.getByRole('button', { name: 'Copie OCR recherchable' })).toBeDisabled();
});

test('OCR en échec : pas de relance pour un valideur sans contracts.import', async () => {
  setup(['LEGAL_REVIEWER'], makeView({
    ocr: { status: 'FAILED', attempts: 3, pages: null, error: 'x', searchablePdf: null },
  }));
  await screen.findByText(/OCR en échec/);
  expect(screen.queryByRole('button', { name: 'Relancer l’OCR' })).not.toBeInTheDocument();
});

test('OCR en cours : état annoncé dans une région aria-live', async () => {
  setup(['LEGAL_REVIEWER'], makeView({
    ocr: { status: 'RUNNING', attempts: 1, pages: null, error: null, searchablePdf: null },
    extraction: null,
  }));
  const msg = await screen.findByText(/actualisation automatique toutes les 5 secondes/);
  const live = msg.closest('[aria-live]');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(within(live as HTMLElement).getByText(/État de l’OCR : En cours/)).toBeInTheDocument();
});

test('import déjà validé : lecture seule, sans bouton', async () => {
  setup(['LEGAL_REVIEWER'], makeView({
    contract: { ...makeView().contract, status: 'ACTIVE' },
    validated: { at: '2026-09-02T09:00:00Z', byUserId: 'u2', fields: {} },
  }));
  expect(await screen.findByText(/Import validé le/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Valider l’import/ })).not.toBeInTheDocument();
});
