import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/** Clients & contacts v2 (lot 1) : consommateur (Chatel), référence Client Help, qualité à signer. */
let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'cv2-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'cv2-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
});
const http = () => request(app.getHttpServer());

describe('clients v2', () => {
  test('création avec statut consommateur et référence Client Help, relus sur la fiche', async () => {
    const res = await http().post('/v1/customers').set('x-lsi-session', 'cv2-admin')
      .send({ name: 'Mme Durand (particulier)', isConsumer: true, externalRef: 'CH-000123' }).expect(201);
    expect(res.body).toMatchObject({ isConsumer: true, externalRef: 'CH-000123' });
    const fiche = await http().get(`/v1/customers/${res.body.id}`).set('x-lsi-session', 'cv2-admin').expect(200);
    expect(fiche.body.customer).toMatchObject({ isConsumer: true, externalRef: 'CH-000123' });
  });

  test('référence externe unique par tenant → 409', async () => {
    await http().post('/v1/customers').set('x-lsi-session', 'cv2-admin').send({ name: 'A', externalRef: 'CH-DUP' }).expect(201);
    await http().post('/v1/customers').set('x-lsi-session', 'cv2-admin').send({ name: 'B', externalRef: 'CH-DUP' }).expect(409);
  });

  test('par défaut un client est professionnel', async () => {
    const res = await http().post('/v1/customers').set('x-lsi-session', 'cv2-admin').send({ name: 'SARL Pro' }).expect(201);
    expect(res.body.isConsumer).toBe(false);
  });

  test('contact signataire avec sa qualité à signer', async () => {
    const res = await http().post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'cv2-admin')
      .send({ firstName: 'Paul', lastName: 'Martin', email: 'p.martin@dupont.fr', isSignatory: true, signingCapacity: 'Président' })
      .expect(201);
    expect(res.body).toMatchObject({ isSignatory: true, signingCapacity: 'Président' });
  });

  test('isolation : un commercial hors portefeuille ne peut pas ajouter de contact (404)', async () => {
    await http().post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'cv2-am-b')
      .send({ firstName: 'X', lastName: 'Y', email: 'x@y.fr' }).expect(404);
  });
});
