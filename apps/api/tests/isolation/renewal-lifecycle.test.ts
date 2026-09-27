import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { LifecycleService } from '../../src/jobs/lifecycle.service.js';
import { DeadlinesService } from '../../src/deadlines/deadlines.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Lot 5 — reconduction tacite, renouvellement exprès, résiliation calculée
 * (brief §2, 02-cycle-de-vie §5).
 */
let app: INestApplication;
let fx: TwoCustomerFixture;

const day = (offset: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function seed(over: Record<string, unknown>) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `REN-${id.slice(-12)}`,
    title: 'Reconduction', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    startDate: day(-400), signedAt: now, activatedAt: now,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
    ...over,
  } }));
  return id;
}

const read = (id: string) => withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => ({
  c: await tx.contract.findUnique({ where: { id } }),
  periods: await tx.contractPeriod.findMany({ where: { contractId: id }, orderBy: { periodNumber: 'asc' } }),
  events: await tx.lifecycleEvent.findMany({ where: { contractId: id }, orderBy: { seq: 'asc' } }),
}));

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ren-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'ren-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'ren-reader', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['READER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const http = () => request(app.getHttpServer());

describe('reconduction TACITE (job quotidien)', () => {
  test('période échue sans dénonciation → prolongée, période tracée, jamais expirée', async () => {
    const end = day(-2);
    const id = await seed({ endDate: end, renewalMode: 'TACIT', renewalPeriodMonths: 12, noticePeriodMonths: 3 });
    await app.get(LifecycleService).run(new Date());
    const { c, periods, events } = await read(id);
    expect(c!.status).toBe('ACTIVE');
    expect(c!.endDate! > new Date()).toBe(true);
    expect(periods.at(-1)).toMatchObject({ kind: 'TACIT_RENEWAL' });
    expect(iso(periods.at(-1)!.startDate)).toBe(iso(day(-1)));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['OPEN_RENEWAL', 'RENEW_PERIOD']));
  });

  test('plusieurs périodes manquées (job interrompu) → rattrapées une à une', async () => {
    const id = await seed({ startDate: day(-1200), endDate: day(-800), renewalMode: 'TACIT', renewalPeriodMonths: 12 });
    await app.get(LifecycleService).run(new Date());
    const { c, periods } = await read(id);
    expect(c!.status).toBe('ACTIVE');
    expect(c!.endDate! >= day(0)).toBe(true);
    expect(periods.filter((p) => p.kind === 'TACIT_RENEWAL').length).toBeGreaterThanOrEqual(2);
  });
});

describe('renouvellement EXPRÈS', () => {
  test('date limite de dénonciation atteinte → RENEWAL_DUE, puis renouvellement décidé', async () => {
    const id = await seed({ endDate: day(20), renewalMode: 'EXPRESS', noticePeriodMonths: 1, renewalPeriodMonths: 12 });
    await app.get(LifecycleService).run(new Date());
    expect((await read(id)).c!.status).toBe('RENEWAL_DUE');

    await http().post(`/v1/contracts/${id}/renewal/renew`).set('x-lsi-session', 'ren-reader').send({}).expect(403);
    await http().post(`/v1/contracts/${id}/renewal/renew`).set('x-lsi-session', 'ren-am-b').send({}).expect(404);
    const r = await http().post(`/v1/contracts/${id}/renewal/renew`).set('x-lsi-session', 'ren-am').send({ months: 24 }).expect(201);
    expect(r.body.status).toBe('ACTIVE');
    const { c, periods } = await read(id);
    expect(periods.at(-1)).toMatchObject({ kind: 'EXPRESS_RENEWAL' });
    expect(c!.endDate! > day(700)).toBe(true);
  });

  test('non-renouvellement décidé (motif obligatoire) → ACTIVE jusqu’au terme', async () => {
    const id = await seed({ endDate: day(10), renewalMode: 'EXPRESS', renewalPeriodMonths: 12, noticePeriodDays: 30 });
    await app.get(LifecycleService).run(new Date());
    await http().post(`/v1/contracts/${id}/renewal/close`).set('x-lsi-session', 'ren-am').send({ reason: '' }).expect(400);
    await http().post(`/v1/contracts/${id}/renewal/close`).set('x-lsi-session', 'ren-am').send({ reason: 'Le client ne renouvelle pas' }).expect(201);
    expect((await read(id)).c!.status).toBe('ACTIVE');
  });

  test('renouvellement exprès non décidé à l’échéance → expire', async () => {
    const id = await seed({ status: 'RENEWAL_DUE', endDate: day(-1), renewalMode: 'EXPRESS', renewalPeriodMonths: 12 });
    await app.get(LifecycleService).run(new Date());
    expect((await read(id)).c!.status).toBe('EXPIRED');
  });
});

describe('résiliation', () => {
  test('sans date fournie : date d’effet CALCULÉE (terme de la période si la date limite n’est pas passée)', async () => {
    const end = day(200);
    const id = await seed({ endDate: end, renewalMode: 'TACIT', renewalPeriodMonths: 12, noticePeriodMonths: 3 });
    const p = await http().get(`/v1/contracts/${id}/termination-preview`).set('x-lsi-session', 'ren-am').expect(200);
    expect(p.body).toMatchObject({ effectiveDate: iso(end), deadlineMissed: false, currentPeriodEnd: iso(end) });
    const r = await http().post(`/v1/contracts/${id}/terminate`).set('x-lsi-session', 'ren-am')
      .send({ reason: 'Fin de collaboration', initiatedBy: 'CLIENT' }).expect(201);
    expect(r.body).toMatchObject({ status: 'TERMINATION_PENDING', effectiveDate: iso(end), noticeRespected: true });
  });

  test('date limite dépassée : la résiliation prend effet au terme de la période SUIVANTE', async () => {
    const end = day(30);
    const id = await seed({ endDate: end, renewalMode: 'TACIT', renewalPeriodMonths: 12, noticePeriodMonths: 3 });
    const p = await http().get(`/v1/contracts/${id}/termination-preview`).set('x-lsi-session', 'ren-am').expect(200);
    expect(p.body.deadlineMissed).toBe(true);
    expect(p.body.effectiveDate > iso(day(360))).toBe(true);
  });

  test('courrier de résiliation (PDF seulement) joint, puis retrait de la résiliation', async () => {
    const id = await seed({ endDate: day(200), noticePeriodDays: 30 });
    await http().post(`/v1/contracts/${id}/termination-letter`).set('x-lsi-session', 'ren-am')
      .attach('letter', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'lettre.pdf', contentType: 'application/pdf' }).expect(409);
    await http().post(`/v1/contracts/${id}/terminate`).set('x-lsi-session', 'ren-am')
      .send({ reason: 'Déménagement', initiatedBy: 'CLIENT' }).expect(201);
    await http().post(`/v1/contracts/${id}/termination-letter`).set('x-lsi-session', 'ren-am')
      .attach('letter', Buffer.from('pas un pdf'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(400);
    const up = await http().post(`/v1/contracts/${id}/termination-letter`).set('x-lsi-session', 'ren-am')
      .attach('letter', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'lettre.pdf', contentType: 'application/pdf' }).expect(201);
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const doc = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.storedDocument.findFirst({ where: { contractId: id, kind: 'TERMINATION_LETTER' } }));
    expect(doc!.sha256).toBe(up.body.sha256);

    await http().post(`/v1/contracts/${id}/withdraw-termination`).set('x-lsi-session', 'ren-am').send({ reason: 'Le client se rétracte' }).expect(201);
    const { c } = await read(id);
    expect(c!.status).toBe('ACTIVE');
    expect(c!.terminationEffectiveDate).toBeNull();
  });

  test('échéance rendue obsolète puis de nouveau due (résiliation retirée) → réactivée avec ses alertes', async () => {
    const id = await seed({ endDate: day(200), renewalMode: 'TACIT', renewalPeriodMonths: 12, noticePeriodMonths: 3 });
    const deadlines = app.get(DeadlinesService);
    const scope = adminScope(fx.tenantId, fx.adminUserId);
    await deadlines.recomputeInScope(scope, id, new Date());
    const open = () => withScope(scope, (tx) => tx.deadline.findMany({ where: { contractId: id, kind: 'NOTICE_DEADLINE' } }));
    expect((await open())[0]!.status).toBe('OPEN');

    await http().post(`/v1/contracts/${id}/terminate`).set('x-lsi-session', 'ren-am').send({ reason: 'Fin', initiatedBy: 'CLIENT' }).expect(201);
    await deadlines.recomputeInScope(scope, id, new Date());
    expect((await open())[0]!.status).toBe('OBSOLETE');

    await http().post(`/v1/contracts/${id}/withdraw-termination`).set('x-lsi-session', 'ren-am').send({ reason: 'Rétractation' }).expect(201);
    const [d] = await open();
    expect(d!.status).toBe('OPEN');
    const pending = await withScope(scope, (tx) => tx.reminder.count({ where: { deadlineId: d!.id, status: 'PENDING' } }));
    expect(pending).toBeGreaterThan(0);
  });
});
