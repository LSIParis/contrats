import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

/** Un contrat ACTIVE (résiliable) chez customerA, préavis 30 j. */
async function seedActive(over: Record<string, unknown> = {}, customer = { id: '' }) {
  const id = uuidv7();
  const vId = uuidv7();
  const now = new Date();
  const cid = customer.id || fx.customerA.id;
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: cid, reference: `LSI-RES-${id.slice(-8)}`,
      title: 'Contrat actif', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
      signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      ...over,
    }});
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId: cid, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}

const plus = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'sess-viewer', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});

const term = (id: string, body: object, sess = 'sess-am') =>
  request(app.getHttpServer()).post(`/v1/contracts/${id}/terminate`).set('x-lsi-session', sess).send(body);

async function cancellations(contractId: string) {
  return withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.cancellation.findMany({ where: { contractId } }));
}

describe('POST /v1/contracts/:id/terminate', () => {
  test('résilie en respectant le préavis → TERMINATED + Cancellation(TERMINATION)', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Fin de collaboration', effectiveDate: plus(31), initiatedBy: 'CLIENT' }).expect(201);
    expect(res.body.status).toBe('TERMINATED');
    expect(res.body.noticeRespected).toBe(true);
    const [c, canc] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { status: true, terminatedAt: true } }),
      await tx.cancellation.findMany({ where: { contractId: id } }),
    ]);
    expect(c!.status).toBe('TERMINATED');
    expect(c!.terminatedAt).toBeTruthy();
    expect(canc).toHaveLength(1);
    expect(canc[0]).toMatchObject({ type: 'TERMINATION', initiatedBy: 'CLIENT', noticeRespected: true });
  });

  test('frontière exacte du préavis (30 j) SANS admin → succès, noticeRespected=true', async () => {
    // effectiveDate = today + noticePeriodDays (30j), exactement la valeur que
    // le FRONT pré-remplit par défaut. La comparaison doit se faire en JOURS
    // (UTC), pas en instants : sinon minuit < now+30j et la frontière est
    // refusée à tort (régression corrigée : isNoticeRespected).
    const id = await seedActive();
    const res = await term(id, { reason: 'Fin de collaboration', effectiveDate: plus(30), initiatedBy: 'CLIENT' }, 'sess-am').expect(201);
    expect(res.body.status).toBe('TERMINATED');
    expect(res.body.noticeRespected).toBe(true);
  });

  test('motif vide → 409 RM-20, rien ne bouge', async () => {
    const id = await seedActive();
    await term(id, { reason: '', effectiveDate: plus(31), initiatedBy: 'LSI' }).expect(400); // MinLength -> 400 validation
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id }, select: { status: true } }));
    expect(c!.status).toBe('ACTIVE');
  });

  test('préavis non respecté SANS admin → 409 RM-20', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Trop tôt', effectiveDate: plus(5), initiatedBy: 'LSI' }, 'sess-am');
    expect(res.status).toBe(409);
    expect(res.body.rule).toBe('RM-20');
    expect(await cancellations(id)).toHaveLength(0);
  });

  test('préavis non respecté AVEC admin + justification → succès, noticeRespected=false, override tracé', async () => {
    const id = await seedActive();
    const res = await term(id, { reason: 'Manquement grave', effectiveDate: plus(5), initiatedBy: 'LSI', overrideReason: 'Résiliation pour faute' }, 'sess-admin').expect(201);
    expect(res.body.noticeRespected).toBe(false);
    const canc = await cancellations(id);
    expect(canc[0]).toMatchObject({ noticeRespected: false, overrideReason: 'Résiliation pour faute', overrideByUserId: fx.adminUserId });
  });

  test('préavis non respecté AVEC admin SANS justification → 409 RM-20', async () => {
    const id = await seedActive();
    await term(id, { reason: 'x', effectiveDate: plus(5), initiatedBy: 'LSI' }, 'sess-admin').expect(409);
  });

  test('résilier un DRAFT → 409 (transition invalide)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    await term(id, { reason: 'x', effectiveDate: plus(31), initiatedBy: 'LSI' }).expect(409);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await term(id, { reason: 'x', effectiveDate: plus(31), initiatedBy: 'LSI' }, 'sess-am-b').expect(404);
  });

  test('rôle non autorisé (LEGAL_REVIEWER) → 403', async () => {
    const id = await seedActive();
    await term(id, { reason: 'x', effectiveDate: plus(31), initiatedBy: 'LSI' }, 'sess-viewer').expect(403);
  });
});

describe('POST /v1/contracts/:id/cancel — trace l\'annulation', () => {
  test('annuler un DRAFT écrit un Cancellation(CANCELLATION)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/cancel`).set('x-lsi-session', 'sess-am').send({ reason: 'Erreur de saisie' }).expect(201);
    const canc = await cancellations(id);
    expect(canc).toHaveLength(1);
    expect(canc[0]).toMatchObject({ type: 'CANCELLATION', reason: 'Erreur de saisie' });
  });
});
