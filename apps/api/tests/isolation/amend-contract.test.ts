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
      id, tenantId: fx.tenantId, customerId, reference: `LSI-AV-${id.slice(-8)}`,
      title: 'Maintenance', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(100000), ownerUserId: fx.amUserId,
      currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), signedAt: now, activatedAt: now,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId, ...over } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
  });
  return id;
}
const amend = (id: string, body: object, sess = 'sess-am') => request(app.getHttpServer()).post(`/v1/contracts/${id}/amend`).set('x-lsi-session', sess).send(body);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'sess-viewer', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId) });
});

describe('POST /v1/contracts/:id/amend', () => {
  test('crée un AMENDMENT DRAFT pré-rempli avec les nouvelles valeurs + lien', async () => {
    const id = await seedActive();
    const res = await amend(id, { reason: 'Extension de périmètre', endDate: '2027-06-30', amountCents: 150000 }).expect(201);
    const newId = res.body.id;
    const av = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: newId }, select: { type: true, status: true, parentContractId: true, title: true, endDate: true, amountCents: true, category: true } }));
    expect(av).toMatchObject({ type: 'AMENDMENT', status: 'DRAFT', parentContractId: id, category: 'MAINTENANCE' });
    expect(av!.title).toContain('avenant');
    expect(av!.endDate?.toISOString().slice(0, 10)).toBe('2027-06-30');
    expect(av!.amountCents).toBe(BigInt(150000));
  });

  test('valeurs omises → copiées du parent', async () => {
    const id = await seedActive();
    const newId = (await amend(id, { reason: 'Simple avenant' }).expect(201)).body.id;
    const av = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: newId }, select: { endDate: true, amountCents: true } }));
    expect(av!.endDate?.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(av!.amountCents).toBe(BigInt(100000));
  });

  test('avenant sur un DRAFT → 409 (RM-17)', async () => {
    const id = await seedActive({ status: 'DRAFT', approvedVersionId: null, signedAt: null, activatedAt: null });
    const res = await amend(id, { reason: 'x' }); expect(res.status).toBe(409); expect(res.body.rule).toBe('RM-17');
  });

  test('second avenant en cours → 409 (RM-19)', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'premier' }).expect(201);
    const res = await amend(id, { reason: 'second' }); expect(res.status).toBe(409);
  });

  test('rôle insuffisant → 403', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'x' }, 'sess-viewer').expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    const id = await seedActive();
    await amend(id, { reason: 'x' }, 'sess-am-b').expect(404);
  });

  test('findOne expose openAmendment (parent) et amends (avenant)', async () => {
    const id = await seedActive();
    const newId = (await amend(id, { reason: 'x' }).expect(201)).body.id;
    const parentView = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(parentView.body.openAmendment).toMatchObject({ id: newId, status: 'DRAFT' });
    const avView = await request(app.getHttpServer()).get(`/v1/contracts/${newId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(avView.body.amends?.id).toBe(id);
  });
});
