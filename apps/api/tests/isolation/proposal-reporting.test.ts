import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, internalScope, uuidv7, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { csvCell, optionCodes } from '../../src/proposals/proposal-reporting.service.js';

/** Lot 9.8 — pilotage commercial (pipeline, tableau de bord, CSV) et propositions dans /api/v1. */
let app: INestApplication;
let fx: TwoCustomerFixture;
let other: TwoCustomerFixture;
const http = () => request(app.getHttpServer());
const DAY = 86_400_000;
const ids: Record<string, string> = {};
let apiKey = '';
let otherProposal = '';
let seq = 1000;

async function flag(f: TwoCustomerFixture, key: string, enabled: boolean) {
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) => tx.tenantFeatureFlag.upsert({
    where: { tenantId_key: { tenantId: f.tenantId, key } },
    create: { tenantId: f.tenantId, key, enabled, updatedAt: new Date() },
    update: { enabled },
  }));
}

async function proposal(f: TwoCustomerFixture, customerId: string, over: Record<string, unknown>) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) => tx.proposal.create({ data: {
    id, tenantId: f.tenantId, customerId, number: `PROP-2026-${String(seq++).padStart(4, '0')}${Math.floor(Math.random() * 1000)}`, title: 'Infogérance',
    ownerUserId: f.amUserId, createdAt: now, updatedAt: now, createdByUserId: f.amUserId, updatedByUserId: f.amUserId,
    ...over,
  } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers();
  for (const f of [fx, other]) {
    await flag(f, 'contrats.proposals.enabled', true);
    await flag(f, 'contrats.api.enabled', true);
  }
  const sent = new Date(Date.now() - 30 * DAY);
  ids.sent = await proposal(fx, fx.customerA.id, { status: 'SENT', sentAt: sent, commitmentTotalCents: 1_200_000n, monthlyCents: 100_000n });
  ids.discussion = await proposal(fx, fx.customerA.id, { status: 'IN_DISCUSSION', sentAt: sent, winProbability: 70, commitmentTotalCents: 3_600_000n, monthlyCents: 100_000n });
  ids.signed = await proposal(fx, fx.customerA.id, { status: 'SIGNED', sentAt: sent, signedAt: new Date(sent.getTime() + 10 * DAY), monthlyCents: 250_000n, oneTimeCents: 50_000n, commitmentTotalCents: 9_050_000n });
  ids.declined = await proposal(fx, fx.customerA.id, { status: 'DECLINED', sentAt: sent, declinedAt: new Date(), declineReasonCode: 'PRIX' });
  ids.otherCustomer = await proposal(fx, fx.customerB.id, { status: 'SENT', sentAt: sent, commitmentTotalCents: 500_000n, ownerUserId: fx.amBUserId });
  otherProposal = await proposal(other, other.customerA.id, { status: 'SENT', sentAt: sent });

  const s = app.get(SessionService);
  await s.put({ sessionId: 'rep-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'rep-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'rep-tech', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  const k = await http().post('/v1/admin/api-clients').set('x-lsi-session', 'rep-admin')
    .send({ name: 'CRM', scopes: ['proposals:read', 'proposals:pricing:read'] }).expect(201);
  apiKey = k.body.apiKey;
});

describe('pipeline', () => {
  test('colonnes par statut, montant et montant pondéré (probabilité saisie, sinon celle de l’étape)', async () => {
    const r = await http().get('/v1/proposal-reports/pipeline').set('x-lsi-session', 'rep-admin').expect(200);
    const col = (s: string) => r.body.columns.find((c: { status: string }) => c.status === s);
    expect(col('SENT')).toMatchObject({ count: 2, amountCents: '1700000', weightedCents: '510000' });
    expect(col('IN_DISCUSSION')).toMatchObject({ count: 1, amountCents: '3600000', weightedCents: '2520000' });
    expect(r.body.items.map((i: { id: string }) => i.id)).not.toContain(ids.signed);
  });

  test('un commercial ne voit que son portefeuille ; un rôle sans droit est refusé', async () => {
    const r = await http().get('/v1/proposal-reports/pipeline').set('x-lsi-session', 'rep-am').expect(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).not.toContain(ids.otherCustomer);
    await http().get('/v1/proposal-reports/pipeline').set('x-lsi-session', 'rep-tech').expect(403);
  });
});

describe('tableau de bord et export', () => {
  test('conversion, délai envoi → signature, récurrent signé, motifs de refus', async () => {
    const r = await http().get('/v1/proposal-reports/dashboard').set('x-lsi-session', 'rep-admin').expect(200);
    expect(r.body).toMatchObject({
      sent: 5, won: 1, lost: 1, open: 3, conversionRatePercent: 20, decidedConversionRatePercent: 50,
      averageDaysSentToSigned: 10, signedRecurringMonthlyCents: '250000', signedOneTimeCents: '50000',
      declineReasons: [{ code: 'PRIX', count: 1 }],
    });
    await http().get('/v1/proposal-reports/dashboard?from=2026-12-01&to=2026-01-01').set('x-lsi-session', 'rep-admin').expect(400);
  });

  test('CSV : BOM, séparateur « ; », indicateurs', async () => {
    const r = await http().get('/v1/proposal-reports/dashboard.csv').set('x-lsi-session', 'rep-admin').buffer(true).expect(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    expect(r.text).toContain('global;taux_conversion_pct;;20');
    expect(r.text).toContain('motif_refus;PRIX;;1');
  });

  test('module désactivé → 404', async () => {
    await flag(fx, 'contrats.proposals.enabled', false);
    try {
      await http().get('/v1/proposal-reports/pipeline').set('x-lsi-session', 'rep-admin').expect(404);
      await http().get('/api/v1/proposals').set('Authorization', `Bearer ${apiKey}`).expect(404);
    } finally {
      await flag(fx, 'contrats.proposals.enabled', true);
    }
  });
});

describe('API publique : propositions', () => {
  const bearer = () => ({ Authorization: `Bearer ${apiKey}` });

  test('liste, filtre, par client, détail, tarif proposé', async () => {
    const all = await http().get('/api/v1/proposals?status=SENT,SIGNED').set(bearer()).expect(200);
    expect(all.body.data.map((p: { status: string }) => p.status).sort()).toEqual(['SENT', 'SENT', 'SIGNED']);
    const byClient = await http().get(`/api/v1/clients/${fx.customerB.id}/proposals`).set(bearer()).expect(200);
    expect(byClient.body.data.map((p: { id: string }) => p.id)).toEqual([ids.otherCustomer]);
    const d = await http().get(`/api/v1/proposals/${ids.signed}`).set(bearer()).expect(200);
    expect(d.body).toMatchObject({ status: 'SIGNED', monthlyCents: '250000', customer: { id: fx.customerA.id } });
    expect(d.body).not.toHaveProperty('recipients');
    const pr = await http().get(`/api/v1/proposals/${ids.sent}/pricing`).set(bearer()).expect(200);
    expect(pr.body).toMatchObject({ source: 'PROPOSED', commitmentTotalCents: '1200000', sha256: null });
  });

  test('isolation entre tenants et scope du tarif', async () => {
    await http().get(`/api/v1/proposals/${otherProposal}`).set(bearer()).expect(404);
    const k = await http().post('/v1/admin/api-clients').set('x-lsi-session', 'rep-admin').send({ name: 'Lecture seule', scopes: ['proposals:read'] }).expect(201);
    const r = await http().get(`/api/v1/proposals/${ids.sent}/pricing`).set('Authorization', `Bearer ${k.body.apiKey}`).expect(403);
    expect(r.body.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('outils', () => {
  test('cellule CSV : formule neutralisée, guillemets échappés, nombres négatifs intacts', () => {
    expect(csvCell('=SOMME(A1)')).toBe("'=SOMME(A1)");
    expect(csvCell('-12')).toBe('-12');
    expect(csvCell('a;"b"')).toBe('"a;""b"""');
  });

  test('options retenues : tableau ou objet', () => {
    expect(optionCodes(['A', 'B'])).toEqual(['A', 'B']);
    expect(optionCodes({ A: true, B: 0, C: 2 })).toEqual(['A', 'C']);
    expect(optionCodes(null)).toEqual([]);
  });
});
