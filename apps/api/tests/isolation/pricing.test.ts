import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeQuantityProvider } from '@lsi/pricing';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DeadlinesService } from '../../src/deadlines/deadlines.service.js';
import { PricingEvents, type PricingRevisedEvent } from '../../src/pricing/pricing-events.js';
import { QUANTITY_PROVIDER } from '../../src/pricing/quantity-provider.js';
import { adminScope, clientScope, internalScope, uuidv7, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Tarification — lot 3 (04-tarification.md §17), de bout en bout sur HTTP :
 * barème versionné, priceAt avec trace, simulateur, dérogations à double
 * validation, indices (saisie + import CSV), catalogue de règles, devis,
 * échéance de révision — et, exigence de la définition de terminé, un tenant
 * ne lit ni ne modifie RIEN de la tarification d'un autre.
 *
 * Aucun appel réseau : quantités fournies par un FakeQuantityProvider.
 */
let app: INestApplication;
let t1: TwoCustomerFixture;
let t2: TwoCustomerFixture;
const events: PricingRevisedEvent[] = [];

// Les entrées du fournisseur factice sont ajoutées après le seed (contrat connu).
const qEntries: { contractRef: string; articleCode: string; effectiveFrom: string; quantity: string; observedAt?: string }[] = [];

beforeAll(async () => {
  const provider = {
    getQuantity: (ref: string, code: string, date: string) => new FakeQuantityProvider(qEntries, 'rmm:fake').getQuantity(ref, code, date),
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(QUANTITY_PROVIDER).useValue(provider)
    .compile();
  app = await createTestApp(mod);
  t1 = await seedTwoCustomers();
  t2 = await seedTwoCustomers(); // second tenant
  app.get(PricingEvents).onPricingRevised((e) => { events.push(e); });
  const s = app.get(SessionService);
  await s.put({ sessionId: 'pr-admin', userId: t1.adminUserId, tenantId: t1.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t1.tenantId, t1.adminUserId) });
  await s.put({ sessionId: 'pr-am', userId: t1.amUserId, tenantId: t1.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(t1.tenantId, [t1.customerA.id], t1.amUserId) });
  await s.put({ sessionId: 'pr-am-b', userId: t1.amBUserId, tenantId: t1.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(t1.tenantId, [t1.customerB.id], t1.amBUserId) });
  await s.put({ sessionId: 'pr-reader', userId: t1.amUserId, tenantId: t1.tenantId, roles: ['READER'], scope: internalScope(t1.tenantId, [t1.customerA.id], t1.amUserId) });
  await s.put({ sessionId: 'pr-client', userId: t1.customerA.clientUserId, tenantId: t1.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(t1.tenantId, t1.customerA.id, t1.customerA.clientUserId) });
  await s.put({ sessionId: 'pr-admin2', userId: t2.adminUserId, tenantId: t2.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t2.tenantId, t2.adminUserId) });
});

const http = () => request(app.getHttpServer());
const A = () => t1.customerA.contractId;
const B = () => t1.customerB.contractId;


/** Ligne de l'exemple chiffré 04 §6.3 : forfait 1 250 € révisé Syntec. */
const forfait = {
  lineKey: 'infogerance', articleCode: 'INFOG', label: 'Infogérance forfaitaire', unit: 'mois',
  kind: 'FLAT_MONTHLY', mode: 'MANUAL', vatRatePercent: '20', unitPrice: '1250',
  revision: { indexCode: 'SYNTEC', a: '0.15', b: '0.85', referenceDate: '2025-09-15', revisionDate: '2026-09-01' },
};

describe('indices : saisie par l’administrateur', () => {
  test('création de la série SYNTEC et saisie des valeurs (fictives, 04 §6.3)', async () => {
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-admin')
      .send({ code: 'SYNTEC', label: 'Indice Syntec (valeurs de test)' }).expect(201);
    await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2025-07', value: '321.5', publishedAt: '2025-08-27' }).expect(201);
    await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2026-07', value: '333.2', publishedAt: '2026-08-26' }).expect(201);
  });

  test('un commercial ne gère pas les indices (403) ; une période publiée ne se ré-écrit pas (409)', async () => {
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-am').send({ code: 'AUTRE', label: 'x' }).expect(403);
    await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-am')
      .send({ period: '2027-07', value: '340', publishedAt: '2027-08-26' }).expect(403);
    const res = await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2025-07', value: '322', publishedAt: '2025-08-27' }).expect(409);
    expect(res.body.code).toBe('PERIOD_ALREADY_PUBLISHED');
  });

  test('série en double → 409 ; code invalide → 400', async () => {
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-admin').send({ code: 'SYNTEC', label: 'bis' }).expect(409);
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-admin').send({ code: 'syntec', label: 'bis' }).expect(400);
  });
});

describe('barème versionné et priceAt', () => {
  test('brouillon : pas de prix engagé (404 NO_SCHEDULE), mais prévisualisation de la version', async () => {
    const res = await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am')
      .send({ validFrom: '2025-09-15', lines: [forfait] }).expect(201);
    expect(res.body).toMatchObject({ version: 1, status: 'DRAFT', validFrom: '2025-09-15', validTo: null });
    expect(res.body.lines[0]).toMatchObject({ lineKey: 'infogerance', unitPrice: '1250', quantity: '1' });

    const none = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-am').expect(404);
    expect(none.body.code).toBe('NO_SCHEDULE');
    const preview = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15&version=1`).set('x-lsi-session', 'pr-am').expect(200);
    expect(preview.body.totals.htCents).toBe('128867');
  });

  test('activation → ACTIVE, événement pricing.revised publié et audité', async () => {
    const res = await http().post(`/v1/contracts/${A()}/pricing/schedules/1/activate`).set('x-lsi-session', 'pr-am').expect(201);
    expect(res.body).toMatchObject({ version: 1, status: 'ACTIVE', activatedByUserId: t1.amUserId });
    expect(events.at(-1)).toMatchObject({ type: 'pricing.revised', cause: 'SCHEDULE_ACTIVATED', contractId: A(), scheduleVersion: 1, effectiveFrom: '2025-09-15' });
    const audit = await withScope(adminScope(t1.tenantId, t1.adminUserId), (tx) =>
      tx.auditLog.findMany({ where: { action: 'pricing.revised', resourceId: A() } }));
    expect(audit.length).toBeGreaterThan(0);
  });

  test('exemple chiffré 04 §6.3 sur HTTP, au centime : 1 288,67 HT, 257,73 TVA, 1 546,40 TTC', async () => {
    const res = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15&trace=true`).set('x-lsi-session', 'pr-am').expect(200);
    expect(res.body).toMatchObject({ contractId: A(), date: '2026-09-15', scheduleVersion: 1, currency: 'EUR' });
    const [line] = res.body.lines;
    expect(line).toMatchObject({ lineId: 'infogerance', unitPrice: '1288.666407', totalHtCents: '128867', recurrence: 'MONTHLY' });
    // Montants en CHAÎNES de centimes (jamais de nombre JSON pour de la monnaie).
    expect(res.body.totals).toMatchObject({
      htCents: '128867', vatCents: '25773', ttcCents: '154640', monthlyRecurringCents: '128867', annualRecurringCents: '1546404',
    });
    const rev = line.trace.find((t: { type: string }) => t.type === 'REVISION');
    expect(rev).toMatchObject({
      P0: '1250', a: '0.15', b: '0.85',
      S0: { indexCode: 'SYNTEC', period: '2025-07', value: '321.5', publishedAt: '2025-08-27' },
      S1: { indexCode: 'SYNTEC', period: '2026-07', value: '333.2', publishedAt: '2026-08-26' },
      ratio: '1.036391912908242612752721617418351477449',
      coefficient: '1.030933125972006220839813374805598755832',
      result: '1288.66640746500777604976671850699844479',
    });
  });

  test('avant la date de révision : P0 ; sans ?trace, pas de trace', async () => {
    const res = await http().get(`/v1/contracts/${A()}/pricing?at=2026-08-31`).set('x-lsi-session', 'pr-reader').expect(200);
    expect(res.body.lines[0]).toMatchObject({ unitPrice: '1250.000000', totalHtCents: '125000' });
    expect(res.body.lines[0].trace).toBeUndefined();
  });

  test('une version engagée ne se modifie plus (409) ; entrée mal formée (400)', async () => {
    const put = await http().put(`/v1/contracts/${A()}/pricing/schedules/1`).set('x-lsi-session', 'pr-am')
      .send({ validFrom: '2025-09-15', lines: [{ ...forfait, unitPrice: '1' }] }).expect(409);
    expect(put.body.code).toBe('SCHEDULE_NOT_DRAFT');
    await http().delete(`/v1/contracts/${A()}/pricing/schedules/1`).set('x-lsi-session', 'pr-am').expect(409);
    // Montant en nombre JSON, virgule décimale, clé en double, champ inconnu : refusés.
    const post = (lines: unknown[], extra: object = {}) =>
      http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am').send({ validFrom: '2027-01-01', lines, ...extra });
    await post([{ ...forfait, unitPrice: 1250 }]).expect(400);
    await post([{ ...forfait, unitPrice: '1250,50' }]).expect(400);
    await post([forfait, forfait]).expect(400);
    await post([forfait], { tenantId: t2.tenantId }).expect(400);
    await http().get(`/v1/contracts/${A()}/pricing?at=15/09/2026`).set('x-lsi-session', 'pr-am').expect(400);
  });

  test('lecture seule pour le lecteur (403 en écriture)', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-reader')
      .send({ validFrom: '2027-01-01', lines: [forfait] }).expect(403);
    const list = await http().get(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-reader').expect(200);
    expect(list.body.items).toHaveLength(1);
  });
});

describe('catalogue de règles et mode RULE', () => {
  test('l’admin crée grille, remise volume et remise d’engagement ; définition validée par type', async () => {
    const post = (b: object) => http().post('/v1/pricing-rules').set('x-lsi-session', 'pr-admin').send(b);
    await post({ code: 'grille', type: 'GRID', label: 'Grille 2026', definition: { entries: [{ articleCode: 'POSTE', unitPrice: '35' }] } }).expect(201);
    await post({ code: 'volume', type: 'VOLUME_DISCOUNT', label: 'Volume', definition: { thresholds: [{ minQuantity: '20', percent: '5' }] } }).expect(201);
    await post({ code: 'engagement', type: 'COMMITMENT_DISCOUNT', label: '36 mois', definition: { thresholds: [{ minMonths: 36, percent: '3' }] } }).expect(201);
    await post({ code: 'bad', type: 'GRID', label: 'x', definition: { entries: [{ articleCode: 'POSTE', unitPrice: 35 }] } }).expect(400);
    await post({ code: 'grille', type: 'GRID', label: 'doublon', definition: { entries: [] } }).expect(409);
    await http().post('/v1/pricing-rules').set('x-lsi-session', 'pr-am')
      .send({ code: 'am', type: 'GRID', label: 'x', definition: { entries: [] } }).expect(403);
  });

  test('ligne RULE en cascade (04 §4.2) : 35 € −5 % −3 % × 25 postes = 806,31 €', async () => {
    const line = {
      lineKey: 'postes', articleCode: 'POSTE', label: 'Postes supervisés', unit: 'poste', kind: 'UNIT', mode: 'RULE',
      vatRatePercent: '20', quantity: '25', rule: { priceRuleId: 'grille', adjustmentRuleIds: ['volume', 'engagement'] },
    };
    await http().post(`/v1/contracts/${B()}/pricing/schedules`).set('x-lsi-session', 'pr-admin')
      .send({ validFrom: '2026-01-01', commitmentMonths: 36, lines: [line] }).expect(201);
    await http().post(`/v1/contracts/${B()}/pricing/schedules/1/activate`).set('x-lsi-session', 'pr-admin').expect(201);
    const res = await http().get(`/v1/contracts/${B()}/pricing?at=2026-01-15`).set('x-lsi-session', 'pr-admin').expect(200);
    expect(res.body.lines[0]).toMatchObject({ unitPrice: '32.252500', totalHtCents: '80631' });
  });

  test('activation refusée pour un barème incalculable (formule invalide → 422), brouillon supprimable', async () => {
    const bad = {
      lineKey: 'f', articleCode: 'F', label: 'Formule', unit: 'u', kind: 'UNIT', mode: 'FORMULA', vatRatePercent: '20',
      formula: { expression: 'P0 * (', basePrice: '10' },
    };
    await http().post(`/v1/contracts/${B()}/pricing/schedules`).set('x-lsi-session', 'pr-admin')
      .send({ validFrom: '2027-01-01', lines: [bad] }).expect(201);
    const res = await http().post(`/v1/contracts/${B()}/pricing/schedules/2/activate`).set('x-lsi-session', 'pr-admin').expect(422);
    expect(res.body.code).toBe('FORMULA_SYNTAX');
    await http().delete(`/v1/contracts/${B()}/pricing/schedules/2`).set('x-lsi-session', 'pr-admin').expect(200);
  });

  test('archivage : la règle n’est plus proposée mais le barème qui la cite reste calculable', async () => {
    await http().post('/v1/pricing-rules/engagement/archive').set('x-lsi-session', 'pr-admin').expect(201);
    const list = await http().get('/v1/pricing-rules').set('x-lsi-session', 'pr-am').expect(200);
    expect(list.body.items.map((r: { code: string }) => r.code)).not.toContain('engagement');
    await http().get(`/v1/contracts/${B()}/pricing?at=2026-01-15`).set('x-lsi-session', 'pr-admin').expect(200)
      .then((r) => expect(r.body.totals.htCents).toBe('80631'));
  });
});

describe('devis (futur POST /api/v1/pricing/quote)', () => {
  test('catalogue : grille du tenant', async () => {
    const res = await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-am')
      .send({ articleCode: 'POSTE', quantity: '25', date: '2026-01-15' }).expect(200);
    expect(res.body).toMatchObject({ source: 'CATALOG', ruleCode: 'grille', line: { totalHtCents: '87500' }, totals: { ttcCents: '105000' } });
  });

  test('client : le barème de SON contrat fait foi (remises comprises)', async () => {
    const res = await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-admin')
      .send({ customerId: t1.customerB.id, articleCode: 'POSTE', quantity: '25', date: '2026-01-15' }).expect(200);
    expect(res.body).toMatchObject({ source: 'CONTRACT', contractId: B(), line: { unitPrice: '32.252500', totalHtCents: '80631' } });
  });

  test('article inconnu → 404 ; client hors portefeuille → 404', async () => {
    await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-am').send({ articleCode: 'NOPE', quantity: '1' }).expect(404);
    await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-am')
      .send({ customerId: t1.customerB.id, articleCode: 'POSTE', quantity: '1' }).expect(404);
  });
});

describe('simulateur', () => {
  test('indice hypothétique : avant / après et écarts, sans rien écrire', async () => {
    const res = await http().post(`/v1/contracts/${A()}/pricing/simulate`).set('x-lsi-session', 'pr-am')
      .send({ at: '2026-09-15', changes: { indexValues: [{ indexCode: 'SYNTEC', period: '2026-07', value: '340' }] } }).expect(200);
    expect(res.body.before.totals.htCents).toBe('128867');
    const after = BigInt(res.body.after.totals.htCents);
    expect(after).toBeGreaterThan(128867n);
    expect(BigInt(res.body.totalsDelta.htCents)).toBe(after - 128867n);
    expect(res.body.lineDeltas[0]).toMatchObject({ lineId: 'infogerance', beforeCents: '128867' });
    // Rien n'a été écrit : le prix réel est inchangé.
    const real = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-am').expect(200);
    expect(real.body.totals.htCents).toBe('128867');
  });

  test('comparaison de dates (prix actuel vs après révision) et quantité simulée', async () => {
    const res = await http().post(`/v1/contracts/${A()}/pricing/simulate`).set('x-lsi-session', 'pr-am')
      .send({ at: '2026-09-15', beforeDate: '2026-08-15', changes: { quantities: [{ lineId: 'infogerance', quantity: '2' }] } }).expect(200);
    expect(res.body.before.totals.htCents).toBe('125000');
    expect(res.body.after.totals.htCents).toBe('257733');
  });

  test('ligne inconnue → 422 ; lecteur → 403', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/simulate`).set('x-lsi-session', 'pr-am')
      .send({ at: '2026-09-15', changes: { quantities: [{ lineId: 'fantome', quantity: '2' }] } }).expect(422);
    await http().post(`/v1/contracts/${A()}/pricing/simulate`).set('x-lsi-session', 'pr-reader')
      .send({ at: '2026-09-15', changes: {} }).expect(403);
  });
});

describe('dérogations et double validation', () => {
  const create = (session: string, body: object) =>
    http().post(`/v1/contracts/${A()}/pricing/overrides`).set('x-lsi-session', session).send(body);
  let pendingId: string;

  test('écart sous le seuil (6,88 % ≤ 10 %) : applicable immédiatement, tracée', async () => {
    const res = await create('pr-am', { lineKey: 'infogerance', unitPrice: '1200', validFrom: '2026-10-01', validTo: '2026-12-31', reason: 'Geste commercial : incident du 12/09' }).expect(201);
    expect(res.body).toMatchObject({ status: 'ACTIVE', requiresSecondApproval: false, computedUnitPrice: '1288.666407' });
    expect(events.at(-1)).toMatchObject({ cause: 'OVERRIDE_EFFECTIVE', overrideId: res.body.id });
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2026-11-01&trace=true`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.lines[0]).toMatchObject({ unitPrice: '1200.000000', totalHtCents: '120000' });
    expect(p.body.lines[0].trace.find((t: { type: string }) => t.type === 'OVERRIDE_APPLIED'))
      .toMatchObject({ reason: 'Geste commercial : incident du 12/09', authorId: t1.amUserId, approvedBy: null });
  });

  test('écart au-delà du seuil : EN ATTENTE, ignorée par priceAt et signalée dans la trace', async () => {
    const res = await create('pr-am', { lineKey: 'infogerance', unitPrice: '900', validFrom: '2027-01-01', validTo: '2027-03-31', reason: 'Remise exceptionnelle de renouvellement' }).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING_APPROVAL', requiresSecondApproval: true });
    pendingId = res.body.id;
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2027-02-01&trace=true`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.lines[0].unitPrice).toBe('1288.666407');
    expect(p.body.lines[0].trace).toContainEqual(expect.objectContaining({ type: 'OVERRIDE_SKIPPED', overrideId: pendingId, reason: 'REQUIRES_SECOND_APPROVAL' }));
    expect(p.body.pendingOverrides).toEqual([expect.objectContaining({ id: pendingId, lineId: 'infogerance' })]);
  });

  test('le commercial ne valide pas (403) ; l’admin ne valide pas SA propre dérogation (403)', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/overrides/${pendingId}/approve`).set('x-lsi-session', 'pr-am').expect(403);
    const own = await create('pr-admin', { lineKey: 'infogerance', unitPrice: '100', validFrom: '2027-07-01', validTo: '2027-07-31', reason: 'Test auto-validation' }).expect(201);
    expect(own.body.status).toBe('PENDING_APPROVAL');
    const res = await http().post(`/v1/contracts/${A()}/pricing/overrides/${own.body.id}/approve`).set('x-lsi-session', 'pr-admin').expect(403);
    expect(res.body.message).toMatch(/autre utilisateur/);
  });

  test('validation par un second utilisateur habilité → appliquée ; revalider → 409', async () => {
    const res = await http().post(`/v1/contracts/${A()}/pricing/overrides/${pendingId}/approve`).set('x-lsi-session', 'pr-admin').expect(201);
    expect(res.body).toMatchObject({ status: 'ACTIVE', approvedByUserId: t1.adminUserId, authorUserId: t1.amUserId });
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2027-02-01`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.lines[0]).toMatchObject({ unitPrice: '900.000000', totalHtCents: '90000' });
    await http().post(`/v1/contracts/${A()}/pricing/overrides/${pendingId}/approve`).set('x-lsi-session', 'pr-admin').expect(409);
  });

  test('refus motivé ; annulation par le commercial ; le prix calculé revient', async () => {
    const pend = await create('pr-am', { lineKey: 'infogerance', unitPrice: '500', validFrom: '2027-04-01', validTo: '2027-04-30', reason: 'Demande client' }).expect(201);
    await http().post(`/v1/contracts/${A()}/pricing/overrides/${pend.body.id}/reject`).set('x-lsi-session', 'pr-admin').send({}).expect(400);
    const rej = await http().post(`/v1/contracts/${A()}/pricing/overrides/${pend.body.id}/reject`).set('x-lsi-session', 'pr-admin')
      .send({ reason: 'Hors politique commerciale' }).expect(201);
    expect(rej.body).toMatchObject({ status: 'REJECTED', rejectedByUserId: t1.adminUserId });

    await http().post(`/v1/contracts/${A()}/pricing/overrides/${pendingId}/cancel`).set('x-lsi-session', 'pr-am').expect(201);
    expect(events.at(-1)).toMatchObject({ cause: 'OVERRIDE_CANCELLED', overrideId: pendingId });
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2027-02-01`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.lines[0].unitPrice).toBe('1288.666407');
  });

  test('saisie invalide : motif vide, période inversée (400), ligne inconnue (404)', async () => {
    await create('pr-am', { lineKey: 'infogerance', unitPrice: '1200', validFrom: '2026-10-01', validTo: '2026-12-31', reason: '  ' }).expect(400);
    await create('pr-am', { lineKey: 'infogerance', unitPrice: '1200', validFrom: '2026-12-31', validTo: '2026-10-01', reason: 'x' }).expect(400);
    await create('pr-am', { lineKey: 'fantome', unitPrice: '1200', validFrom: '2026-10-01', validTo: '2026-12-31', reason: 'x' }).expect(404);
  });

  test('liste des dérogations : interne, cloisonnée', async () => {
    const res = await http().get(`/v1/contracts/${A()}/pricing/overrides`).set('x-lsi-session', 'pr-reader').expect(200);
    expect(res.body.items.map((o: { status: string }) => o.status).sort()).toEqual(['ACTIVE', 'CANCELLED', 'PENDING_APPROVAL', 'REJECTED']);
    await http().get(`/v1/contracts/${A()}/pricing/overrides`).set('x-lsi-session', 'pr-am-b').expect(404);
  });
});

describe('révision = nouvelle version ; les dérogations survivent (line_key stable)', () => {
  test('v2 recopiée de v1 : v1 clôturée la veille (SUPERSEDED), priceAt bascule à la date', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am')
      .send({ validFrom: '2027-09-01', copyFromVersion: 1, note: 'Révision 2027' }).expect(201);
    await http().post(`/v1/contracts/${A()}/pricing/schedules/2/activate`).set('x-lsi-session', 'pr-am').expect(201);
    const list = await http().get(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am').expect(200);
    expect(list.body.items.map((s: { version: number; status: string; validTo: string | null }) => [s.version, s.status, s.validTo]))
      .toEqual([[1, 'SUPERSEDED', '2027-08-31'], [2, 'ACTIVE', null]]);
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2027-09-15`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.scheduleVersion).toBe(2);
  });

  test('une version qui commencerait avant une version engagée est refusée (409)', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am')
      .send({ validFrom: '2027-06-01', copyFromVersion: 2 }).expect(201);
    const res = await http().post(`/v1/contracts/${A()}/pricing/schedules/3/activate`).set('x-lsi-session', 'pr-am').expect(409);
    expect(res.body.code).toBe('SCHEDULE_OVERLAP');
  });

  test('une dérogation posée après la révision s’applique à la version 2 (même clé de ligne)', async () => {
    await http().post(`/v1/contracts/${A()}/pricing/overrides`).set('x-lsi-session', 'pr-am')
      .send({ lineKey: 'infogerance', unitPrice: '1250', validFrom: '2027-10-01', validTo: '2027-10-31', reason: 'Gel du prix un mois' }).expect(201);
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2027-10-15`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body).toMatchObject({ scheduleVersion: 2, lines: [expect.objectContaining({ unitPrice: '1250.000000' })] });
  });
});

describe('quantités fournies (QuantityProvider)', () => {
  test('ligne PROVIDER : quantité du fournisseur, provenance tracée ; inconnue → 409', async () => {
    const c = uuidv7();
    // Un contrat vierge du client A, créé sous le scope admin.
    await withScope(adminScope(t1.tenantId, t1.adminUserId), (tx) =>
      tx.contract.create({
        data: {
          id: c, tenantId: t1.tenantId, customerId: t1.customerA.id, reference: `QP-${c.slice(-12)}`, title: 'Supervision',
          ownerUserId: t1.amUserId, createdByUserId: t1.amUserId, updatedByUserId: t1.amUserId, createdAt: new Date(), updatedAt: new Date(),
        },
      }));
    const line = { lineKey: 'postes', articleCode: 'POSTE', label: 'Postes', unit: 'poste', kind: 'UNIT', mode: 'MANUAL', vatRatePercent: '20', unitPrice: '30', quantitySource: 'PROVIDER' };
    await http().post(`/v1/contracts/${c}/pricing/schedules`).set('x-lsi-session', 'pr-am').send({ validFrom: '2026-01-01', lines: [line] }).expect(201);
    await http().post(`/v1/contracts/${c}/pricing/schedules/1/activate`).set('x-lsi-session', 'pr-am').expect(201);

    const missing = await http().get(`/v1/contracts/${c}/pricing?at=2026-03-01`).set('x-lsi-session', 'pr-am').expect(409);
    expect(missing.body.code).toBe('QUANTITY_UNAVAILABLE');

    qEntries.push({ contractRef: c, articleCode: 'POSTE', effectiveFrom: '2026-02-01', quantity: '42', observedAt: '2026-02-01T06:00:00Z' });
    const p = await http().get(`/v1/contracts/${c}/pricing?at=2026-03-01&trace=true`).set('x-lsi-session', 'pr-am').expect(200);
    expect(p.body.lines[0]).toMatchObject({ quantity: '42', totalHtCents: '126000' });
    expect(p.body.lines[0].trace[0]).toMatchObject({ type: 'QUANTITY', source: 'rmm:fake', quantity: '42' });
  });
});

describe('import d’indices par connecteur CSV', () => {
  const upload = (code: string, csv: string, session = 'pr-admin') =>
    http().post(`/v1/price-indexes/${code}/values/import`).set('x-lsi-session', session)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'indices.csv', contentType: 'text/csv' });

  test('fichier valide : lignes importées (virgule décimale selon le paramétrage), ré-import idempotent', async () => {
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-admin')
      .send({ code: 'INSEE_TEST', label: 'Indice de test', connector: { type: 'CSV', delimiter: ';', decimalComma: true } }).expect(201);
    const csv = 'period;value;publishedAt\n2024-01;100,5;2024-02-15\n# commentaire\n\n2024-02;101.25\n';
    const res = await upload('INSEE_TEST', csv).expect(201);
    expect(res.body).toMatchObject({ imported: 2, unchanged: 0, periods: ['2024-01', '2024-02'] });
    const again = await upload('INSEE_TEST', csv).expect(201);
    expect(again.body).toMatchObject({ imported: 0, unchanged: 2 });
    const values = await http().get('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-am').expect(200);
    expect(values.body.items.map((v: { period: string; value: string; source: string; publishedAt: string }) => [v.period, v.value, v.source]))
      .toEqual([['2024-01', '100.5', 'IMPORT'], ['2024-02', '101.25', 'IMPORT']]);
    expect(values.body.items[0].publishedAt).toBe('2024-02-15');
  });

  test('lignes invalides : 422, erreurs numérotées, RIEN n’est importé (tout ou rien)', async () => {
    const csv = '2024-03;102\n2024-13;1\n2024-04;abc\n2024-03;103\n2024-01;999\n2024-05;1;2024-04-01\n';
    const res = await upload('INSEE_TEST', csv).expect(422);
    expect(res.body.code).toBe('INVALID_IMPORT');
    expect(res.body.errors.map((e: { line: number }) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(res.body.errors.find((e: { line: number }) => e.line === 5).message).toMatch(/déjà publié/);
    const values = await http().get('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin').expect(200);
    expect(values.body.items.map((v: { period: string }) => v.period)).toEqual(['2024-01', '2024-02']);
  });

  test('fichier vide → 422 ; sans fichier → 400 ; commercial → 403', async () => {
    await upload('INSEE_TEST', '\n# rien\n').expect(422);
    await http().post('/v1/price-indexes/INSEE_TEST/values/import').set('x-lsi-session', 'pr-admin').field('x', 'y').expect(400);
    await upload('INSEE_TEST', '2024-06;1\n', 'pr-am').expect(403);
  });

  test('correction explicite : nouvelle ligne chaînée, l’ancienne reste visible mais n’est plus courante', async () => {
    const before = await http().get('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin').expect(200);
    const jan = before.body.items.find((v: { period: string }) => v.period === '2024-01');
    await http().post('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2024-01', value: '100.7', publishedAt: '2024-03-01', supersedesId: jan.id }).expect(400); // motif manquant
    const fix = await http().post('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2024-01', value: '100.7', publishedAt: '2024-03-01', supersedesId: jan.id, correctionReason: 'Erratum de l’éditeur' }).expect(201);
    expect(fix.body).toMatchObject({ revision: 1, supersedesId: jan.id, current: true });
    const after = await http().get('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin').expect(200);
    const janRows = after.body.items.filter((v: { period: string }) => v.period === '2024-01');
    expect(janRows.map((v: { value: string; current: boolean }) => [v.value, v.current])).toEqual([['100.5', false], ['100.7', true]]);
    // Corriger une valeur qui n'est plus la courante : 409.
    await http().post('/v1/price-indexes/INSEE_TEST/values').set('x-lsi-session', 'pr-admin')
      .send({ period: '2024-01', value: '100.8', publishedAt: '2024-03-02', supersedesId: jan.id, correctionReason: 'bis' }).expect(409);
  });
});

describe('isolation multi-tenant et portefeuille (définition de terminé)', () => {
  test('un autre tenant ne LIT rien : barème, prix, dérogations, simulateur (404) ; indices et règles invisibles', async () => {
    for (const path of [
      `/v1/contracts/${A()}/pricing?at=2026-09-15`,
      `/v1/contracts/${A()}/pricing/schedules`,
      `/v1/contracts/${A()}/pricing/overrides`,
    ]) {
      await http().get(path).set('x-lsi-session', 'pr-admin2').expect(404);
    }
    await http().post(`/v1/contracts/${A()}/pricing/simulate`).set('x-lsi-session', 'pr-admin2').send({ at: '2026-09-15', changes: {} }).expect(404);
    const idx = await http().get('/v1/price-indexes').set('x-lsi-session', 'pr-admin2').expect(200);
    expect(idx.body.items).toEqual([]);
    await http().get('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin2').expect(404);
    const rules = await http().get('/v1/pricing-rules?archived=true').set('x-lsi-session', 'pr-admin2').expect(200);
    expect(rules.body.items).toEqual([]);
    await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-admin2').send({ articleCode: 'POSTE', quantity: '1' }).expect(404);
    await http().post('/v1/pricing/quote').set('x-lsi-session', 'pr-admin2')
      .send({ contractId: A(), articleCode: 'INFOG', quantity: '1' }).expect(404);
  });

  test('un autre tenant ne MODIFIE rien : barème, activation, dérogations, validation, indices, règles', async () => {
    const [someOverride] = await withScope(adminScope(t1.tenantId, t1.adminUserId), (tx) => tx.priceOverride.findMany({ where: { contractId: A() }, take: 1 }));
    await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-admin2').send({ validFrom: '2030-01-01', lines: [forfait] }).expect(404);
    await http().put(`/v1/contracts/${A()}/pricing/schedules/3`).set('x-lsi-session', 'pr-admin2').send({ validFrom: '2030-01-01', lines: [forfait] }).expect(404);
    await http().delete(`/v1/contracts/${A()}/pricing/schedules/3`).set('x-lsi-session', 'pr-admin2').expect(404);
    await http().post(`/v1/contracts/${A()}/pricing/schedules/3/activate`).set('x-lsi-session', 'pr-admin2').expect(404);
    await http().post(`/v1/contracts/${A()}/pricing/overrides`).set('x-lsi-session', 'pr-admin2')
      .send({ lineKey: 'infogerance', unitPrice: '1', validFrom: '2027-01-01', validTo: '2027-01-31', reason: 'intrusion' }).expect(404);
    for (const action of ['approve', 'cancel']) {
      await http().post(`/v1/contracts/${A()}/pricing/overrides/${someOverride!.id}/${action}`).set('x-lsi-session', 'pr-admin2').expect(404);
    }
    await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin2')
      .send({ period: '2027-07', value: '1', publishedAt: '2027-08-01' }).expect(404);
    await http().put('/v1/pricing-rules/grille').set('x-lsi-session', 'pr-admin2').send({ label: 'piratée' }).expect(404);
    await http().post('/v1/pricing-rules/grille/archive').set('x-lsi-session', 'pr-admin2').expect(404);

    // Et rien n'a bougé chez le tenant 1.
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-admin').expect(200);
    expect(p.body.totals.htCents).toBe('128867');
    const rule = await http().get('/v1/pricing-rules').set('x-lsi-session', 'pr-admin').expect(200);
    expect(rule.body.items.find((r: { code: string }) => r.code === 'grille').label).toBe('Grille 2026');
    const schedules = await withScope(adminScope(t1.tenantId, t1.adminUserId), (tx) => tx.pricingSchedule.count({ where: { contractId: A() } }));
    expect(schedules).toBe(3);
  });

  test('un tenant peut avoir SA série SYNTEC, sans collision ni fuite', async () => {
    await http().post('/v1/price-indexes').set('x-lsi-session', 'pr-admin2').send({ code: 'SYNTEC', label: 'Syntec tenant 2' }).expect(201);
    await http().post('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin2')
      .send({ period: '2026-07', value: '1', publishedAt: '2026-08-26' }).expect(201);
    const mine = await http().get('/v1/price-indexes/SYNTEC/values').set('x-lsi-session', 'pr-admin').expect(200);
    expect(mine.body.items.map((v: { value: string }) => v.value)).toEqual(['321.5', '333.2']);
    const p = await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-admin').expect(200);
    expect(p.body.totals.htCents).toBe('128867');
  });

  test('portefeuille : le commercial du client B ne voit ni ne modifie le barème du client A (404)', async () => {
    await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-am-b').expect(404);
    await http().post(`/v1/contracts/${A()}/pricing/schedules`).set('x-lsi-session', 'pr-am-b').send({ validFrom: '2030-01-01', lines: [forfait] }).expect(404);
  });

  test('une session client n’accède pas à l’API interne de tarification (403)', async () => {
    await http().get(`/v1/contracts/${A()}/pricing?at=2026-09-15`).set('x-lsi-session', 'pr-client').expect(403);
    await http().get('/v1/price-indexes').set('x-lsi-session', 'pr-client').expect(403);
  });
});

describe('échéancier : la révision tarifaire vient du barème', () => {
  test('PRICE_REVISION à la date de révision prévue, puis à la date anniversaire une fois passée', async () => {
    // Contrat B : ligne à révision sur une version sans fin, contrat engagé.
    const c = B();
    const admin = adminScope(t1.tenantId, t1.adminUserId);
    const line = { ...forfait, lineKey: 'forfait-b', revision: { ...forfait.revision, revisionDate: '2027-01-01' } };
    await http().post(`/v1/contracts/${c}/pricing/schedules`).set('x-lsi-session', 'pr-admin')
      .send({ validFrom: '2026-06-01', lines: [line] }).expect(201);
    await http().post(`/v1/contracts/${c}/pricing/schedules/2/activate`).set('x-lsi-session', 'pr-admin').expect(201);
    await withScope(admin, (tx) => tx.contract.update({ where: { id: c }, data: { status: 'ACTIVE', startDate: new Date('2026-01-01') } }));

    const deadlines = app.get(DeadlinesService);
    await deadlines.recomputeInScope(admin, c, new Date('2026-10-01T08:00:00Z'));
    const open = () => withScope(admin, (tx) => tx.deadline.findMany({ where: { contractId: c, kind: 'PRICE_REVISION', status: 'OPEN' } }));
    expect((await open()).map((d) => d.dueDate.toISOString().slice(0, 10))).toEqual(['2027-01-01']);

    // Une fois la date passée, l'échéance devient l'anniversaire (V2-H24) ; l'ancienne est close.
    await deadlines.recomputeInScope(admin, c, new Date('2027-02-01T08:00:00Z'));
    expect((await open()).map((d) => d.dueDate.toISOString().slice(0, 10))).toEqual(['2028-01-01']);

    const list = await http().get(`/v1/contracts/${c}/pricing/schedules`).set('x-lsi-session', 'pr-admin').expect(200);
    expect(list.body.nextRevisionDate).toMatch(/^\d{4}-01-01$/);
  });
});
