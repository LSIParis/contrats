import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture; let clientUserId: string;

async function seedContract(customerId: string, ownerUserId: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId, reference: `LSI-CM-${id.slice(-8)}`,
    title: 'Avec commentaires', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId,
    createdAt: now, updatedAt: now, createdByUserId: ownerUserId, updatedByUserId: ownerUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  // Un utilisateur CLIENT rattaché au customerA (kind CLIENT) : rôle non autorisé pour l'API interne.
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: 'client-comments-internal@example.com', fullName: 'Client Test', status: 'ACTIVE',
    createdAt: new Date(), updatedAt: new Date() } }));
  await sessions.put({ sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_VIEWER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId) }, 3600);
});
const asAmA = () => request(app.getHttpServer());

describe('commentaires interne', () => {
  test('POST puis GET rend le commentaire avec sa visibilité et son auteur', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: 'Note interne', visibility: 'INTERNAL' }).expect(201);
    const res = await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ body: 'Note interne', visibility: 'INTERNAL' });
    expect(res.body.items[0].author.fullName).toBeTruthy();
  });

  test('visibilité par défaut = INTERNAL si absente du DTO', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: 'Sans visibilité' }).expect(201);
    const res = await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items[0].visibility).toBe('INTERNAL');
  });

  test('TECHNICIAN est autorisé sur l’API interne (INTERNAL élargi) ; un rôle client ne l’est pas → 403', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    // TECHNICIAN : GET/POST INTERNAL désormais autorisés (§6.10 différée B).
    await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-tech').expect(200);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-tech')
      .send({ body: 'x' }).expect(201);
    // Rôle client (CLIENT_VIEWER) : toujours non autorisé sur l'API interne → 403.
    await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-client').expect(403);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-client')
      .send({ body: 'x' }).expect(403);
  });

  test('body vide → 400', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asAmA().post(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a')
      .send({ body: '' }).expect(400);
  });

  test('contrat hors portefeuille → 404', async () => {
    const id = await seedContract(fx.customerB.id, fx.amBUserId);
    await asAmA().get(`/v1/contracts/${id}/comments`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
