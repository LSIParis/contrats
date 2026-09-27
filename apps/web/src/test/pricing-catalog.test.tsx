import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PricingCatalogPage } from '../features/pricing/pricing-catalog-page.js';
import { json, mockApi, problem, renderWithClient, type Route } from './api-mock.js';

const INDEXES = {
  items: [{
    id: 'i1', code: 'SYNTEC', label: 'Indice Syntec', description: null, connector: null, valuesCount: 2,
    latest: { period: '2026-06', value: '334.2', publishedAt: '2026-07-01' },
  }],
};
const VALUES = {
  code: 'SYNTEC', label: 'Indice Syntec',
  items: [
    { id: 'v1', period: '2025-06', value: '321.5', publishedAt: '2025-07-01', source: 'IMPORT', revision: 0, supersedesId: null, correctionReason: null, enteredByUserId: null, createdAt: '', current: true },
    { id: 'v2', period: '2026-06', value: '334.2', publishedAt: '2026-07-01', source: 'MANUAL', revision: 0, supersedesId: null, correctionReason: null, enteredByUserId: null, createdAt: '', current: true },
  ],
};
const RULES = {
  items: [
    { id: 'r1', code: 'grille-2026', type: 'GRID', label: 'Grille 2026', definition: { entries: [{ articleCode: 'POSTE', unitPrice: '35' }] }, archivedAt: null, createdAt: '', updatedAt: '' },
    { id: 'r2', code: 'volume', type: 'VOLUME_DISCOUNT', label: 'Remise volume', definition: { thresholds: [{ minQuantity: '20', percent: '5' }] }, archivedAt: null, createdAt: '', updatedAt: '' },
  ],
};

const base: Route[] = [
  ['GET', '/v1/price-indexes', () => INDEXES],
  ['GET', '/v1/price-indexes/SYNTEC/values', () => VALUES],
  ['GET', /^\/v1\/pricing-rules(\?.*)?$/, () => RULES],
  ['GET', '/v1/customers', () => ({ items: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Dupont SAS' }] })],
];

afterEach(() => vi.unstubAllGlobals());

test('indices : liste, création d’un indice (administrateur)', async () => {
  const user = userEvent.setup();
  const calls = mockApi([['POST', '/v1/price-indexes', (b) => ({ id: 'i2', ...(b as object) })], ...base]);
  renderWithClient(<PricingCatalogPage />);
  const table = await screen.findByRole('table', { name: 'Indices de prix' });
  expect(within(table).getByText('SYNTEC')).toBeInTheDocument();
  expect(within(table).getByText('2026-06 : 334,2 (publiée le 01/07/2026)')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Nouvel indice' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvel indice' });
  await user.type(within(dialog).getByLabelText('Code'), 'insee_ict');
  await user.type(within(dialog).getByLabelText('Libellé'), 'Indice ICT');
  await user.selectOptions(within(dialog).getByLabelText('Séparateur du fichier CSV'), ',');
  await user.click(within(dialog).getByRole('button', { name: 'Créer l’indice' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
    code: 'INSEE_ICT', label: 'Indice ICT', connector: { type: 'CSV', delimiter: ',' },
  });
});

test('valeurs d’un indice : saisie, conflit de période affiché, correction avec motif', async () => {
  const user = userEvent.setup();
  let n = 0;
  const calls = mockApi([
    ['POST', '/v1/price-indexes/SYNTEC/values', () => (n++ === 0
      ? problem(409, 'SYNTEC 2026-06 est déjà publié (334.2) : une correction passe par supersedesId + motif.')
      : json({ id: 'v3' }))],
    ...base,
  ]);
  renderWithClient(<PricingCatalogPage />);
  await user.click(await screen.findByRole('button', { name: 'Valeurs de SYNTEC' }));
  const region = await screen.findByRole('region', { name: 'Valeurs — SYNTEC' });
  const values = await within(region).findByRole('table', { name: 'Valeurs de SYNTEC' });
  expect(within(values).getAllByRole('row')).toHaveLength(3);
  await user.type(within(region).getByLabelText('Période (AAAA-MM)'), '2026-06');
  await user.type(within(region).getByLabelText('Valeur'), '335,1');
  await user.type(within(region).getByLabelText('Publiée le'), '2026-07-15');
  await user.click(within(region).getByRole('button', { name: 'Enregistrer la valeur' }));
  expect(await within(region).findByRole('alert')).toHaveTextContent('déjà publié');
  expect(calls.filter((c) => c.method === 'POST')[0]!.body).toEqual({ period: '2026-06', value: '335.1', publishedAt: '2026-07-15' });

  await user.click(within(values).getByRole('button', { name: 'Corriger 2026-06' }));
  await user.type(within(region).getByLabelText('Motif de la correction'), 'Erratum INSEE');
  await user.click(within(region).getByRole('button', { name: 'Enregistrer la correction' }));
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
  expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({
    period: '2026-06', value: '335.1', publishedAt: '2026-07-15', supersedesId: 'v2', correctionReason: 'Erratum INSEE',
  });
});

test('import CSV : multipart « file », erreurs numérotées affichées, puis succès', async () => {
  const user = userEvent.setup();
  let n = 0;
  const calls = mockApi([
    ['POST', '/v1/price-indexes/SYNTEC/values/import', () => (n++ === 0
      ? problem(422, '1 ligne(s) invalide(s) : aucune valeur importée.', { errors: [{ line: 3, message: 'valeur invalide « abc »' }] })
      : json({ code: 'SYNTEC', connector: 'CSV', imported: 2, unchanged: 1, periods: ['2026-07', '2026-08'] }))],
    ...base,
  ]);
  renderWithClient(<PricingCatalogPage />);
  await user.click(await screen.findByRole('button', { name: 'Valeurs de SYNTEC' }));
  const region = await screen.findByRole('region', { name: 'Valeurs — SYNTEC' });
  const file = new File(['period;value\n2026-07;336\n2026-08;abc\n'], 'syntec.csv', { type: 'text/csv' });
  await user.upload(within(region).getByLabelText('Fichier CSV'), file);
  await user.click(within(region).getByRole('button', { name: 'Importer le fichier' }));
  const alert = await within(region).findByRole('alert');
  expect(alert).toHaveTextContent('aucune valeur importée');
  expect(alert).toHaveTextContent('Ligne 3 : valeur invalide « abc »');
  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.body).toBeInstanceOf(FormData);
  expect((post.body as FormData).get('file')).toBeInstanceOf(File);
  await user.click(within(region).getByRole('button', { name: 'Importer le fichier' }));
  expect(await within(region).findByText('2 valeur(s) importée(s) (2026-07, 2026-08), 1 inchangée(s).')).toBeInTheDocument();
});

test('règles : création d’une grille par lignes, archivage confirmé', async () => {
  const user = userEvent.setup();
  const calls = mockApi([
    ['POST', '/v1/pricing-rules', (b) => ({ id: 'r3', ...(b as object), archivedAt: null })],
    ['POST', '/v1/pricing-rules/volume/archive', () => ({ ...RULES.items[1], archivedAt: '2026-09-27T00:00:00Z' })],
    ...base,
  ]);
  renderWithClient(<PricingCatalogPage />);
  await user.click(await screen.findByRole('tab', { name: 'Règles' }));
  const table = await screen.findByRole('table', { name: 'Règles de prix' });
  expect(within(table).getByText('Grille de prix par article')).toBeInTheDocument();
  expect(within(table).getByText('1 article(s)')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Nouvelle règle' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle règle' });
  await user.type(within(dialog).getByLabelText('Code'), 'grille-2027');
  await user.type(within(dialog).getByLabelText('Libellé'), 'Grille 2027');
  await user.type(within(dialog).getByLabelText('Article 1'), 'POSTE');
  await user.type(within(dialog).getByLabelText('Prix unitaire HT 1'), '36,5');
  await user.click(within(dialog).getByRole('button', { name: 'Ajouter une ligne' }));
  await user.type(within(dialog).getByLabelText('Article 2'), 'SERVEUR');
  await user.type(within(dialog).getByLabelText('Prix unitaire HT 2'), '120');
  await user.click(within(dialog).getByRole('button', { name: 'Créer la règle' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/v1/pricing-rules' && c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.url === '/v1/pricing-rules' && c.method === 'POST')!.body).toEqual({
    code: 'grille-2027', type: 'GRID', label: 'Grille 2027',
    definition: { entries: [{ articleCode: 'POSTE', unitPrice: '36.5' }, { articleCode: 'SERVEUR', unitPrice: '120' }] },
  });

  await user.click(within(table).getByRole('button', { name: 'Archiver volume' }));
  const confirm = await screen.findByRole('dialog', { name: 'Archiver la règle volume' });
  await user.click(within(confirm).getByRole('button', { name: 'Archiver' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/volume/archive'))).toBe(true));
});

test('devis : article, quantité, client → prix et totaux ; ambiguïté expliquée', async () => {
  const user = userEvent.setup();
  let n = 0;
  const calls = mockApi([
    ['POST', '/v1/pricing/quote', () => (n++ === 0
      ? problem(409, 'Plusieurs contrats du client portent l’article « POSTE » au 2026-09-27 : préciser contractId.', { code: 'QUOTE_AMBIGUOUS' })
      : json({
        source: 'CATALOG', ruleCode: 'grille-2026', articleCode: 'POSTE', quantity: '25', date: '2026-09-27',
        line: { lineId: 'quote', code: 'POSTE', label: 'POSTE', unit: 'unité', kind: 'UNIT', mode: 'RULE', recurrence: 'MONTHLY', quantity: '25', unitPrice: '35.000000', vatRatePercent: '20', totalHtCents: '87500' },
        totals: { htCents: '87500', vatCents: '17500', ttcCents: '105000', vatByRate: [], monthlyRecurringCents: '87500', annualRecurringCents: '1050000' },
      }))],
    ...base,
  ], { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<PricingCatalogPage />);
  expect(await screen.findByRole('tab', { name: 'Indices' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nouvel indice' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Devis' }));
  const region = await screen.findByRole('region', { name: 'Devis rapide' });
  await user.type(within(region).getByLabelText('Code article'), 'POSTE');
  await user.type(within(region).getByLabelText('Quantité'), '25');
  await user.selectOptions(await within(region).findByLabelText('Client (facultatif)'), 'Dupont SAS');
  await user.click(within(region).getByRole('button', { name: 'Calculer le prix' }));
  expect(await within(region).findByRole('alert')).toHaveTextContent('préciser contractId');
  expect(calls.find((c) => c.url === '/v1/pricing/quote')!.body).toEqual({
    articleCode: 'POSTE', quantity: '25', customerId: '33333333-3333-4333-8333-333333333333',
  });
  await user.click(within(region).getByRole('button', { name: 'Calculer le prix' }));
  expect(await within(region).findByText(/Catalogue du tenant — règle grille-2026/)).toBeInTheDocument();
  expect(within(region).getByText(/^1 050,00 €$/)).toBeInTheDocument();
});

test('lecteur : pas d’onglet Devis', async () => {
  mockApi(base, { userId: 'u-r', roles: ['READER'] });
  renderWithClient(<PricingCatalogPage />);
  await screen.findByRole('table', { name: 'Indices de prix' });
  expect(screen.queryByRole('tab', { name: 'Devis' })).not.toBeInTheDocument();
});
