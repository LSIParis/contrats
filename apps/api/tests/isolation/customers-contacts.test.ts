import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('POST /v1/customers/:id/contacts', () => {
  test('ajoute un contact au client de A', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'Jean', lastName: 'Dupont', email: 'jd@a.fr', isPrimary: true })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.email).toBe('jd@a.fr');
  });

  test('email dupliqué pour ce client → 409', async () => {
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'A', lastName: 'B', email: 'dup@a.fr' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerA.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'C', lastName: 'D', email: 'dup@a.fr' }).expect(409);
  });

  test('IDOR : ajouter un contact au client de B → 404', async () => {
    await request(app.getHttpServer())
      .post(`/v1/customers/${fx.customerB.id}/contacts`).set('x-lsi-session', 'sess-am-a')
      .send({ firstName: 'X', lastName: 'Y', email: 'xy@b.fr' }).expect(404);
  });
});
