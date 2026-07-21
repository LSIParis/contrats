import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, clientScope, systemScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture; let clientUserId: string;
const CLIENT_EMAIL = 'commenter-a@example.com';

async function seedContract(customerId: string, ownerUserId: string, status = 'ACTIVE') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId, reference: `LSI-PC-${id.slice(-8)}`,
    title: 'Portail commentaires', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId,
    createdAt: now, updatedAt: now, createdByUserId: ownerUserId, updatedByUserId: ownerUserId } }));
  return id;
}
async function seedComment(contractId: string, customerId: string, visibility: 'INTERNAL' | 'SHARED') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
    id, tenantId: fx.tenantId, customerId, contractId, authorUserId: fx.amUserId,
    visibility, body: `corps ${visibility}`, createdAt: now, updatedAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: CLIENT_EMAIL, fullName: 'Client A', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } }));
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId) }, 1800);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const asClient = (m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', 'sess-client');

describe('commentaires portail', () => {
  test('le portail ne voit QUE les commentaires SHARED', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await seedComment(id, fx.customerA.id, 'INTERNAL');
    await seedComment(id, fx.customerA.id, 'SHARED');
    const res = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].body).toBe('corps SHARED');
    expect(JSON.stringify(res.body)).not.toContain('corps INTERNAL');
  });

  test('POST portail crée un commentaire SHARED (visible interne + portail)', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    const post = await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'Bonjour LSI' }).expect(201);
    expect(post.body.id).toBeTruthy();
    // visible côté portail
    const list = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    expect(list.body.items.map((i: any) => i.body)).toContain('Bonjour LSI');
    // créé en SHARED en base
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.comment.findMany({ where: { contractId: id }, select: { visibility: true, authorUserId: true } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visibility: 'SHARED', authorUserId: clientUserId });
  });

  test('un POST portail crée une Notification pour le propriétaire du contrat', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'Merci de rappeler' }).expect(201);
    // notifications_scope : un utilisateur ne lit QUE ses propres notifications,
    // quel que soit son rôle (même un admin all_customers). adminScope (acteur
    // INTERNAL) ne peut donc pas lire l'inbox de fx.amUserId — il faut le scope
    // SYSTEM (webhooks/jobs), seul à contourner ce filtre par recipient.
    const notifs = await withScope(systemScope(fx.tenantId, fx.customerA.id), (tx) =>
      tx.notification.findMany({ where: { relatedContractId: id }, select: { recipientUserId: true, type: true } }));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ recipientUserId: fx.amUserId, type: 'CLIENT_COMMENT' });
  });

  test('contrat d’un autre client (IDOR) → 404 en lecture comme en écriture', async () => {
    const id = await seedContract(fx.customerB.id, fx.amBUserId);
    await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(404);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: 'x' }).expect(404);
  });

  test('body vide → 400', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    await asClient('post', `/v1/portal/contracts/${id}/comments`).send({ body: '' }).expect(400);
  });

  test('un commentaire SHARED supprimé apparaît masqué (body null) au portail', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    const cid = uuidv7(); const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
      id: cid, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, authorUserId: fx.amUserId,
      visibility: 'SHARED', body: 'à supprimer', editedAt: now, deletedAt: now, deletedByUserId: fx.amUserId,
      createdAt: now, updatedAt: now } }));
    const res = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    const it = res.body.items.find((i: any) => i.id === cid);
    expect(it).toBeTruthy();
    expect(it.body).toBeNull();
    expect(it.deletedAt).not.toBeNull();
    expect(it.editedAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('à supprimer');
  });
});
