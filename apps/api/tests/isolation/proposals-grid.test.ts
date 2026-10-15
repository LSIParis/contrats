import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, internalScope, withScope } from '@lsi/persistence';
import { seedContractKindsFor, seedProposalTemplates, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';

/**
 * Codes de la grille tarifaire dans les documents (13-types-contrats.md §7) :
 * modèles de propositions, propositions (copie des prix, changement des
 * durées proposées avec bascule, « sans engagement »), devis.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
const http = () => request(app.getHttpServer());
const AM = 'pg-am';
const ADMIN = 'pg-admin';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type Def = {
  choices: { key: string; options: { value: string; label: string; commitmentMonths?: number; default?: boolean }[] }[];
  lines: { key: string; label: string; pricing: { byChoice?: Record<string, number>; dependsOn?: string }; priceStatus: string; grid?: { itemCode: string; variants: Record<string, string> } }[];
};

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  await seedProposalTemplates(fx.tenantSlug);
  await seedContractKindsFor(fx.tenantSlug);
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.proposals.enabled', enabled: true, updatedAt: new Date() } }),
  );
  const s = app.get(SessionService);
  await s.put({ sessionId: AM, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: ADMIN, userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });

  // Grille RSSI : RSSI-0001 proposé en 0/12/24/36 mois ; RSSI-0002 seulement en 12 mois.
  const kinds = await http().get('/v1/contract-kinds').set('x-lsi-session', ADMIN).expect(200);
  const rssi = kinds.body.items.find((k: { prefix: string }) => k.prefix === 'RSSI');
  await http().post(`/v1/contract-kinds/${rssi.id}/grid/items`).set('x-lsi-session', ADMIN).send({
    label: 'Supervision SOC', unit: 'PER_DEVICE', recurrence: 'MONTHLY', vatRatePercent: '20', effectiveFrom: '2026-01-01',
    prices: [{ months: 0, unitPrice: '12' }, { months: 12, unitPrice: '10' }, { months: 24, unitPrice: '9.5' }, { months: 36, unitPrice: '9' }],
  }).expect(201);
  await http().post(`/v1/contract-kinds/${rssi.id}/grid/items`).set('x-lsi-session', ADMIN).send({
    label: 'Audit annuel', unit: 'FLAT', recurrence: 'MONTHLY', vatRatePercent: '20', effectiveFrom: '2026-01-01',
    prices: [{ months: 12, unitPrice: '300' }],
  }).expect(201);
});

const def = (body: { version: { pricingDefinition: Def } }) => body.version.pricingDefinition;
const engagement = (d: Def) => d.choices.find((c) => c.key === 'engagement')!;

describe('propositions', () => {
  let id: string;

  test('ajout depuis la grille : code, libellé et prix par durée COPIÉS, validés', async () => {
    const r = await http().post('/v1/proposals').set('x-lsi-session', AM).send({ customerId: fx.customerA.id, templateSlug: 'rssi' }).expect(201);
    id = r.body.proposal.id;
    const res = await http().post(`/v1/proposals/${id}/pricing/grid-lines`).set('x-lsi-session', AM).send({ itemCode: 'RSSI-0001', quantity: 10 }).expect(201);
    const line = def(res.body).lines.find((l) => l.key === 'rssi-0001')!;
    expect(line).toMatchObject({
      label: 'Supervision SOC', priceStatus: 'VALIDATED',
      pricing: { dependsOn: 'engagement', byChoice: { 12: 1000, 24: 950, 36: 900 } },
      grid: { itemCode: 'RSSI-0001', variants: { 12: 'RSSI-0001-E12', 24: 'RSSI-0001-E24', 36: 'RSSI-0001-E36' } },
    });
  });

  test('une durée de la proposition sans version proposée : ajout refusé, versions manquantes listées', async () => {
    const res = await http().post(`/v1/proposals/${id}/pricing/grid-lines`).set('x-lsi-session', AM).send({ itemCode: 'RSSI-0002' }).expect(422);
    expect(res.body).toMatchObject({ code: 'MISSING_DURATIONS', details: ['RSSI-0002-E24 (24 mois)', 'RSSI-0002-E36 (36 mois)'] });
  });

  test('la grille change ensuite : la proposition garde les prix copiés', async () => {
    await http().post('/v1/price-grid/items/RSSI-0001/prices').set('x-lsi-session', ADMIN)
      .send({ effectiveFrom: '2026-01-01', prices: [{ months: 12, unitPrice: '11' }] }).expect(201);
    const r = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(def(r.body).lines.find((l) => l.key === 'rssi-0001')!.pricing.byChoice).toEqual({ 12: 1000, 24: 950, 36: 900 });
  });

  test('changement des durées SANS bascule : prix copiés conservés, nouvelle durée lue dans la grille', async () => {
    const r = await http().put(`/v1/proposals/${id}/pricing/commitments`).set('x-lsi-session', AM)
      .send({ months: [0, 12, 24, 36], defaultMonths: 12, switchGridLines: false }).expect(200);
    const d = def(r.body);
    expect(engagement(d).options.map((o) => [o.value, o.label, o.commitmentMonths])).toEqual([
      ['0', 'Sans engagement', 0], ['12', '12 mois', 12], ['24', '24 mois', 24], ['36', '36 mois', 36],
    ]);
    const line = d.lines.find((l) => l.key === 'rssi-0001')!;
    expect(line.pricing.byChoice).toEqual({ 0: 1200, 12: 1000, 24: 950, 36: 900 });
    expect(line.grid!.variants['0']).toBe('RSSI-0001-E00');
    // Lignes hors grille : la nouvelle durée prend le prix de la plus proche, à valider.
    const other = d.lines.find((l) => !l.grid && l.pricing.dependsOn === 'engagement');
    if (other) expect(other.pricing.byChoice!['0']).toBe(other.pricing.byChoice!['12']);
  });

  test('changement des durées AVEC bascule : les lignes de grille reprennent les prix des versions', async () => {
    const r = await http().put(`/v1/proposals/${id}/pricing/commitments`).set('x-lsi-session', AM)
      .send({ months: [0, 12], defaultMonths: 0, switchGridLines: true }).expect(200);
    const d = def(r.body);
    const line = d.lines.find((l) => l.key === 'rssi-0001')!;
    expect(line.pricing.byChoice).toEqual({ 0: 1200, 12: 1100 });
    expect(line.priceStatus).toBe('VALIDATED');
    expect(engagement(d).options.find((o) => o.default)?.commitmentMonths).toBe(0);
  });

  test('sans engagement : configuration à 0 mois, aucune durée d’engagement', async () => {
    await http().put(`/v1/proposals/${id}/selection`).set('x-lsi-session', AM).send({ choices: { engagement: '0' } }).expect(200);
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(d.body.selection.choices.engagement).toBe('0');
    expect(d.body.quote.commitmentMonths).toBe(0);
  });

  test('retirer la durée retenue : la configuration revient à la durée par défaut', async () => {
    const r = await http().put(`/v1/proposals/${id}/pricing/commitments`).set('x-lsi-session', AM)
      .send({ months: [12, 24], defaultMonths: 24, switchGridLines: true }).expect(200);
    expect(r.body.selection.choices.engagement).toBeUndefined();
    expect(r.body.quote.commitmentMonths).toBe(24);
  });
});

describe('modèles de propositions', () => {
  test('nouvelle ligne de modèle depuis la grille (administrateur)', async () => {
    await http().post('/v1/proposal-admin/templates/rssi/grid-lines').set('x-lsi-session', AM).send({ itemCode: 'RSSI-0001' }).expect(403);
    const res = await http().post('/v1/proposal-admin/templates/rssi/grid-lines').set('x-lsi-session', ADMIN).send({ itemCode: 'RSSI-0001', kind: 'OPTIONAL' }).expect(201);
    const line = (res.body.definition as Def).lines.find((l) => l.key === 'rssi-0001')!;
    expect(line).toMatchObject({ priceStatus: 'VALIDATED', pricing: { byChoice: { 12: 1100, 24: 950, 36: 900 } }, grid: { itemCode: 'RSSI-0001' } });
    // Une proposition créée ensuite hérite de la ligne et de sa référence de grille.
    const p = await http().post('/v1/proposals').set('x-lsi-session', AM).send({ customerId: fx.customerA.id, templateSlug: 'rssi' }).expect(201);
    expect(def(p.body).lines.find((l) => l.key === 'rssi-0001')?.grid?.itemCode).toBe('RSSI-0001');
  });
});

describe('devis', () => {
  test('un code de version de la grille se chiffre au prix en vigueur', async () => {
    const res = await http().post('/v1/pricing/quote').set('x-lsi-session', AM).send({ articleCode: 'RSSI-0001-E36', quantity: '10', date: today }).expect(200);
    expect(res.body).toMatchObject({ source: 'GRID', articleCode: 'RSSI-0001-E36', gridItemCode: 'RSSI-0001', commitmentMonths: 36 });
    expect(res.body.line).toMatchObject({ label: 'Supervision SOC', unit: 'par poste', unitPrice: '9.000000', vatRatePercent: '20', totalHtCents: '9000' });
    expect(res.body.totals).toMatchObject({ htCents: '9000', vatCents: '1800', monthlyRecurringCents: '9000' });
  });
});
