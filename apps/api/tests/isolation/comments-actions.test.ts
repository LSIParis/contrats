import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-CA-${id.slice(-8)}`,
    title: 'Actions', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}
async function seedComment(contractId: string, authorUserId: string, visibility: 'INTERNAL'|'SHARED') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, authorUserId,
    visibility, body: `corps ${visibility}`, createdAt: now, updatedAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-tech', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amBUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post'|'patch'|'delete', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('commentaires — actions & états', () => {
  test('TECHNICIAN peut poster INTERNAL mais pas SHARED', async () => {
    const c = await seedContract();
    await req('sess-tech', 'post', `/v1/contracts/${c}/comments`).send({ body: 'note tech', visibility: 'INTERNAL' }).expect(201);
    await req('sess-tech', 'post', `/v1/contracts/${c}/comments`).send({ body: 'partage tech', visibility: 'SHARED' }).expect(403);
    // et il voit bien la liste interne
    await req('sess-tech', 'get', `/v1/contracts/${c}/comments`).expect(200);
  });

  test('resolve / unresolve pose puis efface resolvedAt', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'post', `/v1/contracts/${c}/comments/${m}/resolve`).expect(201);
    let list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).resolvedAt).not.toBeNull();
    await req('sess-am-a', 'post', `/v1/contracts/${c}/comments/${m}/unresolve`).expect(201);
    list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).resolvedAt).toBeNull();
  });

  test('share : INTERNAL→SHARED, puis 409 si déjà partagé', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}/share`).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).visibility).toBe('SHARED');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}/share`).expect(409);
  });

  test('édition : auteur OK (editedAt posé), non-auteur 403, admin OK', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'corrigé' }).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    const it = list.body.items.find((i: any) => i.id === m);
    expect(it.body).toBe('corrigé'); expect(it.editedAt).not.toBeNull();
    // technicien (non-auteur, non-admin) → 403
    await req('sess-tech', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'hack' }).expect(403);
    // admin → OK
    await req('sess-admin', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'admin edit' }).expect(200);
  });

  test('suppression douce : body masqué partout, édition d’un supprimé → 409', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'delete', `/v1/contracts/${c}/comments/${m}`).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    const it = list.body.items.find((i: any) => i.id === m);
    expect(it.body).toBeNull(); expect(it.deletedAt).not.toBeNull();
    // la ligne existe toujours en base (suppression douce)
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.comment.findMany({ where: { id: m }, select: { deletedAt: true, body: true } }));
    expect(rows).toHaveLength(1); expect(rows[0].deletedAt).not.toBeNull();
    // éditer un supprimé → 409
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'x' }).expect(409);
  });

  test('non-auteur non-admin ne peut pas supprimer (403)', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-tech', 'delete', `/v1/contracts/${c}/comments/${m}`).expect(403);
  });
});
