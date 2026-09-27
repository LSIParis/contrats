import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractPricing } from '../features/pricing/contract-pricing.js';
import { mockApi, problem, renderWithClient, type Route } from './api-mock.js';

const K = '11111111-1111-4111-8111-111111111111';
const BASE = `/v1/contracts/${K}/pricing`;

const LINE = {
  lineKey: 'infogerance', sortOrder: 0, articleCode: 'INFOG', label: 'Infogérance', unit: 'mois', kind: 'FLAT_MONTHLY',
  mode: 'MANUAL', recurrence: 'MONTHLY', vatRatePercent: '20', quantitySource: 'FIXED', quantity: '1', unitPrice: '1250',
  revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-15' },
};
const POSTES = {
  lineKey: 'postes', sortOrder: 1, articleCode: 'POSTE', label: 'Postes supervisés', unit: 'poste', kind: 'UNIT',
  mode: 'MANUAL', recurrence: 'MONTHLY', vatRatePercent: '20', quantitySource: 'FIXED', quantity: '25', unitPrice: '35',
};
const sched = (version: number, status: string, validFrom: string, validTo: string | null, lines: unknown[] = [LINE, POSTES]) => ({
  id: `s${version}`, version, status, validFrom, validTo, currency: 'EUR', commitmentMonths: 36, note: null,
  createdByUserId: 'u-am', activatedByUserId: status === 'DRAFT' ? null : 'u-admin', activatedAt: null, lines,
});
const SCHEDULES = {
  items: [
    sched(1, 'SUPERSEDED', '2024-09-15', '2025-09-14'),
    sched(2, 'ACTIVE', '2025-09-15', null),
    sched(3, 'DRAFT', '2026-09-15', null, [LINE]),
  ],
  nextRevisionDate: '2026-09-15',
};

const PRICE = {
  contractId: K, date: '2026-09-27', scheduleId: 's2', scheduleVersion: 2, scheduleValidFrom: '2025-09-15', scheduleValidTo: null,
  currency: 'EUR', settings: { rounding: 'HALF_AWAY_FROM_ZERO', unitPriceScale: 6, overrideApprovalThresholdPercent: '10', indexLookup: 'LATEST_PUBLISHED' },
  lines: [{
    lineId: 'infogerance', code: 'INFOG', label: 'Infogérance', unit: 'mois', kind: 'FLAT_MONTHLY', mode: 'MANUAL', recurrence: 'MONTHLY',
    quantity: '1', unitPrice: '1288.666407', vatRatePercent: '20', totalHtCents: '128867',
    trace: [
      { type: 'QUANTITY', source: 'FIXED', quantity: '1', observedAt: null },
      { type: 'BASE_PRICE', mode: 'MANUAL', unitPrice: '1250' },
      { type: 'OVERRIDE_SKIPPED', overrideId: 'o1', reason: 'REQUIRES_SECOND_APPROVAL', gapPercent: '24' },
      { type: 'LINE_TOTAL', unitPrice: '1288.666407', quantity: '1', exact: '1288.666407' },
    ],
  }],
  totals: {
    htCents: '128867', vatCents: '25773', ttcCents: '154640', vatByRate: [{ ratePercent: '20', baseHtCents: '128867', vatCents: '25773' }],
    monthlyLinesCents: '128867', yearlyLinesCents: '0', oneOffCents: '0', monthlyRecurringCents: '128867', annualRecurringCents: '1546404',
  },
  pendingOverrides: [{ id: 'o1', lineId: 'infogerance', unitPrice: '1600', reason: 'Geste commercial', authorUserId: 'u-am' }],
};

const OVERRIDES = {
  items: [
    {
      id: '22222222-2222-4222-8222-222222222222', lineKey: 'infogerance', unitPrice: '1600', validFrom: '2026-10-01', validTo: '2026-12-31',
      reason: 'Geste commercial', computedUnitPrice: '1288.666407', gapPercent: '24.1592', requiresSecondApproval: true,
      status: 'PENDING_APPROVAL', authorUserId: 'u-am', approvedByUserId: null, approvedAt: null, rejectedByUserId: null,
      rejectedAt: null, rejectionReason: null, cancelledByUserId: null, cancelledAt: null, createdAt: '2026-09-20T10:00:00Z',
    },
  ],
};

function routes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    ['GET', `${BASE}/schedules`, () => SCHEDULES],
    ['GET', new RegExp(`^${BASE}\\?`), () => PRICE],
    ['GET', `${BASE}/overrides`, () => OVERRIDES],
    ['GET', '/v1/pricing-rules', () => ({ items: [] })],
    ['GET', '/v1/price-indexes', () => ({ items: [] })],
  ];
}

afterEach(() => vi.unstubAllGlobals());

test('versions du barème : statuts, validité, prochaine révision ; commandes selon le droit', async () => {
  mockApi(routes(), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  const table = await screen.findByRole('table', { name: 'Versions du barème' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(3);
  expect(within(rows[0]!).getByText('Remplacée')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('Active')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('Brouillon')).toBeInTheDocument();
  expect(screen.getByText(/Prochaine révision tarifaire : 15\/09\/2026/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activer la version 3' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Activer la version 2' })).not.toBeInTheDocument();
});

test('lecteur : aucune commande d’écriture', async () => {
  mockApi(routes(), { userId: 'u-r', roles: ['READER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await screen.findByRole('table', { name: 'Versions du barème' });
  expect(screen.queryByRole('button', { name: /Activer la version/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nouvelle version' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Demander une dérogation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Simulateur' })).not.toBeInTheDocument();
});

test('activation d’un brouillon : confirmation, POST, erreur serveur affichée', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['POST', `${BASE}/schedules/3/activate`, () => problem(409, 'La version 2 (engagée à partir du 2025-09-15) couvre déjà cette période.')],
  ]), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await user.click(await screen.findByRole('button', { name: 'Activer la version 3' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activer la version 3' });
  expect(within(dialog).getByText(/clôturées la veille du 15\/09\/2026/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Activer' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('couvre déjà cette période');
  expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`${BASE}/schedules/3/activate`]);
});

test('nouvelle version par copie d’une version engagée', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['POST', `${BASE}/schedules`, () => sched(4, 'DRAFT', '2027-01-01', null)],
  ]), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await user.click(await screen.findByRole('button', { name: 'Nouvelle version' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nouvelle version du barème' });
  await user.type(within(dialog).getByLabelText('Valide à partir du'), '2027-01-01');
  await user.selectOptions(within(dialog).getByLabelText('Lignes de départ'), '2');
  await user.click(within(dialog).getByRole('button', { name: 'Créer le brouillon' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ validFrom: '2027-01-01', copyFromVersion: 2, commitmentMonths: 36 });
  // Le brouillon créé s'ouvre en édition.
  expect(await screen.findByRole('heading', { name: 'Version 4 (brouillon) — édition' })).toBeInTheDocument();
});

test('édition d’un brouillon : PUT du barème complet au format de l’API', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['PUT', `${BASE}/schedules/3`, (b) => ({ ...sched(3, 'DRAFT', '2026-09-15', null), ...(b as object) })],
  ]), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await user.click(await screen.findByRole('button', { name: 'Modifier la version 3' }));
  const editor = await screen.findByRole('region', { name: 'Version 3 (brouillon) — édition' });
  const line1 = within(editor).getByRole('group', { name: 'Ligne 1 — Infogérance' });
  const price = within(line1).getByLabelText('Prix unitaire HT (€)');
  await user.clear(price);
  await user.type(price, '1 300,50');
  await user.click(within(editor).getByRole('button', { name: 'Enregistrer le brouillon' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
    validFrom: '2026-09-15', validTo: null, commitmentMonths: 36, note: null,
    lines: [{
      lineKey: 'infogerance', articleCode: 'INFOG', label: 'Infogérance', unit: 'mois', kind: 'FLAT_MONTHLY', mode: 'MANUAL',
      recurrence: 'MONTHLY', vatRatePercent: '20', quantitySource: 'FIXED', quantity: '1', unitPrice: '1300.50',
      revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-15' },
    }],
  });
});

test('ajout d’une ligne en paliers dans le brouillon', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['PUT', `${BASE}/schedules/3`, () => sched(3, 'DRAFT', '2026-09-15', null)],
  ]), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await user.click(await screen.findByRole('button', { name: 'Modifier la version 3' }));
  const editor = await screen.findByRole('region', { name: 'Version 3 (brouillon) — édition' });
  await user.click(within(editor).getByRole('button', { name: 'Ajouter une ligne' }));
  const fs = within(editor).getByRole('group', { name: 'Ligne 2' });
  await user.clear(within(fs).getByLabelText('Clé de ligne'));
  await user.type(within(fs).getByLabelText('Clé de ligne'), 'postes');
  await user.type(within(fs).getByLabelText('Code article'), 'POSTE');
  await user.type(within(fs).getByLabelText('Libellé'), 'Postes');
  await user.selectOptions(within(fs).getByLabelText('Type de ligne'), 'TIERED');
  await user.clear(within(fs).getByLabelText('Quantité'));
  await user.type(within(fs).getByLabelText('Quantité'), '12');
  await user.type(within(fs).getByLabelText('Borne haute du palier 1'), '10');
  await user.type(within(fs).getByLabelText('Prix unitaire du palier 1'), '30');
  await user.click(within(fs).getByRole('button', { name: 'Ajouter un palier' }));
  await user.type(within(fs).getByLabelText('Prix unitaire du palier 2'), '25');
  await user.click(within(editor).getByRole('button', { name: 'Enregistrer le brouillon' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  const body = calls.find((c) => c.method === 'PUT')!.body as { lines: unknown[] };
  expect(body.lines[1]).toEqual({
    lineKey: 'postes', articleCode: 'POSTE', label: 'Postes', unit: 'mois', kind: 'TIERED', mode: 'MANUAL', vatRatePercent: '20',
    quantitySource: 'FIXED', quantity: '12', tiers: { mode: 'GRADUATED', tiers: [{ upTo: '10', unitPrice: '30' }, { upTo: null, unitPrice: '25' }] },
  });
});

test('prix à une date avec trace : totaux en centimes formatés, trace, dérogation en attente signalée', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes(), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  const card = await screen.findByRole('region', { name: 'Prix à une date' });
  const date = within(card).getByLabelText('Date du calcul');
  await user.clear(date);
  await user.type(date, '2026-09-27');
  await user.click(within(card).getByLabelText('Afficher la trace de calcul'));
  await user.click(within(card).getByRole('button', { name: 'Calculer' }));
  expect(await within(card).findByText(/^15 464,04 €$/)).toBeInTheDocument(); // récurrent annuel
  expect(within(card).getByText(/^1 546,40 €$/)).toBeInTheDocument(); // TTC
  expect(within(card).getByText(/^1 288,666407 €$/)).toBeInTheDocument();
  expect(within(card).getByText('Dérogation écartée : seconde validation requise (écart 24 %)')).toBeInTheDocument();
  expect(within(card).getByText(/1 dérogation en attente de seconde validation/)).toBeInTheDocument();
  const get = calls.filter((c) => c.url.startsWith(`${BASE}?`)).pop()!;
  expect(get.url).toBe(`${BASE}?at=2026-09-27&trace=true`);
});

test('prix à une date : le `detail` du serveur est affiché (aucune version)', async () => {
  const user = userEvent.setup();
  mockApi([
    ['GET', new RegExp(`^${BASE}\\?`), () => problem(404, 'Aucune version de barème ne couvre le 2020-01-01.', { code: 'NO_SCHEDULE' })],
    ...routes(),
  ], { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  const card = await screen.findByRole('region', { name: 'Prix à une date' });
  const date = within(card).getByLabelText('Date du calcul');
  await user.clear(date);
  await user.type(date, '2020-01-01');
  await user.click(within(card).getByRole('button', { name: 'Calculer' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent('Aucune version de barème ne couvre le 2020-01-01.');
});

test('simulateur : quantités et valeur d’indice hypothétiques → corps exact, écarts affichés', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['POST', `${BASE}/simulate`, () => ({
      contractId: K, before: PRICE, after: { ...PRICE, totals: { ...PRICE.totals, htCents: '146367' } },
      lineDeltas: [{ lineId: 'postes', label: 'Postes supervisés', beforeCents: '87500', afterCents: '105000', deltaCents: '17500', deltaPercent: '20' }],
      totalsDelta: { htCents: '17500', vatCents: '3500', ttcCents: '21000', monthlyRecurringCents: '17500', annualRecurringCents: '210000' },
    })],
  ]), { userId: 'u-lr', roles: ['LEGAL_REVIEWER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  const card = await screen.findByRole('region', { name: 'Simulateur' });
  const at = within(card).getByLabelText('Date « après »');
  await user.clear(at);
  await user.type(at, '2026-10-01');
  await user.type(within(card).getByLabelText('Date « avant » (facultatif)'), '2026-09-01');
  await user.type(within(card).getByLabelText('Nouvelle quantité — Postes supervisés'), '30');
  await user.click(within(card).getByRole('button', { name: 'Ajouter une valeur d’indice' }));
  await user.type(within(card).getByLabelText('Indice 1'), 'SYNTEC');
  await user.type(within(card).getByLabelText('Période 1'), '2026-06');
  await user.type(within(card).getByLabelText('Valeur 1'), '340,1');
  await user.click(within(card).getByRole('button', { name: 'Simuler' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/simulate'))).toBe(true));
  expect(calls.find((c) => c.url.endsWith('/simulate'))!.body).toEqual({
    at: '2026-10-01', beforeDate: '2026-09-01',
    changes: { quantities: [{ lineId: 'postes', quantity: '30' }], indexValues: [{ indexCode: 'SYNTEC', period: '2026-06', value: '340.1' }] },
  });
  const deltas = await within(card).findByRole('table', { name: 'Écarts par ligne' });
  expect(within(deltas).getByText(/^[+]175,00 €$/)).toBeInTheDocument();
  expect(within(deltas).getByText('+20 %')).toBeInTheDocument();
  expect(within(card).getByText(/^[+]2 100,00 €$/)).toBeInTheDocument();
});

test('dérogation : demande avec motif → corps exact', async () => {
  const user = userEvent.setup();
  const calls = mockApi(routes([
    ['POST', `${BASE}/overrides`, (b) => ({ ...OVERRIDES.items[0], ...(b as object), id: 'new', status: 'ACTIVE', gapPercent: '3' })],
  ]), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  await user.click(await screen.findByRole('button', { name: 'Demander une dérogation' }));
  const dialog = await screen.findByRole('dialog', { name: 'Demander une dérogation' });
  await user.selectOptions(within(dialog).getByLabelText('Ligne'), 'postes');
  await user.type(within(dialog).getByLabelText('Prix unitaire HT dérogatoire (€)'), '33,5');
  await user.type(within(dialog).getByLabelText('Du'), '2026-10-01');
  await user.type(within(dialog).getByLabelText('Au (inclus)'), '2026-12-31');
  const submit = within(dialog).getByRole('button', { name: 'Envoyer la demande' });
  expect(submit).toBeDisabled(); // motif obligatoire
  await user.type(within(dialog).getByLabelText('Motif (obligatoire)'), 'Alignement concurrent');
  await user.click(submit);
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
    lineKey: 'postes', unitPrice: '33.5', validFrom: '2026-10-01', validTo: '2026-12-31', reason: 'Alignement concurrent',
  });
});

test('dérogation en attente : un administrateur (non auteur) valide ou refuse avec motif', async () => {
  const user = userEvent.setup();
  const OID = OVERRIDES.items[0]!.id;
  const calls = mockApi(routes([
    ['POST', `${BASE}/overrides/${OID}/reject`, () => ({ ...OVERRIDES.items[0], status: 'REJECTED' })],
    ['POST', `${BASE}/overrides/${OID}/approve`, () => ({ ...OVERRIDES.items[0], status: 'ACTIVE' })],
  ]));
  renderWithClient(<ContractPricing contractId={K} />);
  const table = await screen.findByRole('table', { name: 'Dérogations tarifaires' });
  expect(within(table).getByText('En attente de seconde validation')).toBeInTheDocument();
  expect(within(table).getByText('24,1592 %')).toBeInTheDocument();
  await user.click(within(table).getByRole('button', { name: 'Refuser' }));
  const dialog = await screen.findByRole('dialog', { name: 'Refuser la dérogation' });
  const confirm = within(dialog).getByRole('button', { name: 'Refuser la dérogation' });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByLabelText('Motif du refus (obligatoire)'), 'Écart injustifié');
  await user.click(confirm);
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reject'))).toBe(true));
  expect(calls.find((c) => c.url.endsWith('/reject'))!.body).toEqual({ reason: 'Écart injustifié' });
  await user.click(within(table).getByRole('button', { name: 'Valider' }));
  const approve = await screen.findByRole('dialog', { name: 'Valider la dérogation' });
  await user.click(within(approve).getByRole('button', { name: 'Valider la dérogation' }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true));
});

test('dérogation : l’auteur ne valide pas la sienne ; un commercial ne valide pas', async () => {
  mockApi(routes(), { userId: 'u-am', roles: ['ACCOUNT_MANAGER'] });
  renderWithClient(<ContractPricing contractId={K} />);
  const table = await screen.findByRole('table', { name: 'Dérogations tarifaires' });
  expect(within(table).queryByRole('button', { name: 'Valider' })).not.toBeInTheDocument();
  expect(within(table).getByRole('button', { name: 'Annuler la dérogation' })).toBeInTheDocument();
});
