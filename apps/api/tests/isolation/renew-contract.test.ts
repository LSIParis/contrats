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

async function seedActive(over: Record<string, unknown> = {}, cid?: string) {
  const id = uuidv7(); const vId = uuidv7(); const now = new Date();
  const customerId = cid ?? fx.customerA.id;
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId, reference: `LSI-REN-${id.slice(-8)}`,
      title: 'Maintenance', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(120000), ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId, ...over } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}
const renew = (id: string, sess = 'sess-am') => request(app.getHttpServer()).post(`/v1/contracts/${id}/renew`).set('x-lsi-session', sess);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'sess-viewer', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
});

describe('POST /v1/contracts/:id/renew', () => {
  test('crée un successeur DRAFT pré-rempli + RenewalRequest PENDING + liens', async () => {
    const id = await seedActive();
    const res = await renew(id).expect(201);
    const newId = res.body.id;
    expect(newId).toBeTruthy();
    const [parent, succ, rr] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { successorContractId: true } }),
      await tx.contract.findUnique({ where: { id: newId }, select: { type: true, status: true, predecessorContractId: true, title: true, noticePeriodDays: true, startDate: true, endDate: true } }),
      await tx.renewalRequest.findFirst({ where: { contractId: id } }),
    ]);
    expect(parent!.successorContractId).toBe(newId);
    expect(succ).toMatchObject({ type: 'MAIN', status: 'DRAFT', predecessorContractId: id, noticePeriodDays: 30 });
    expect(succ!.title).toContain('renouvellement');
    // début = fin du parent (2026-12-31) + 1 j = 2027-01-01
    expect(succ!.startDate?.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(rr).toMatchObject({ status: 'PENDING', newContractId: newId, initiatedByUserId: fx.amUserId });
  });

  test('renouveler un DRAFT → 409 (RM-16)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    const res = await renew(id); expect(res.status).toBe(409); expect(res.body.rule).toBe('RM-16');
  });

  test('double renouvellement → 409', async () => {
    const id = await seedActive();
    await renew(id).expect(201);
    await renew(id).expect(409);
  });

  test('rôle insuffisant → 403', async () => {
    const id = await seedActive();
    await renew(id, 'sess-viewer').expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await renew(id, 'sess-am-b').expect(404);
  });

  test('findOne expose renewal (parent) et predecessor (successeur)', async () => {
    const id = await seedActive();
    const newId = (await renew(id).expect(201)).body.id;
    const parentView = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(parentView.body.renewal).toMatchObject({ status: 'PENDING', newContractId: newId });
    const succView = await request(app.getHttpServer()).get(`/v1/contracts/${newId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(succView.body.predecessor?.id).toBe(id);
  });
});
