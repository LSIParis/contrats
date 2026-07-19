import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope } from '@lsi/persistence';
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
  await sessions.put({
    sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId),
  });
});

describe('POST /v1/customers', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).post('/v1/customers').send({ name: 'X' }).expect(401);
  });

  test('un AM crée un client et le voit dans la réponse (auto-accès + scope rafraîchi)', async () => {
    // La réponse 201 est LUE par le service sous le scope RAFRAÎCHI (le service
    // re-résout depuis customer_access après l'insert). Si le rafraîchissement
    // n'avait pas eu lieu, la relecture sous le scope de login (qui n'inclut
    // pas ce client neuf) échouerait — pas de 201 avec le bon corps. Ce test
    // ne dépend donc PAS des endpoints de lecture (Task 2).
    const create = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('x-lsi-session', 'sess-am-a')
      .send({ name: 'Nouvelle SARL', siren: '123456789', city: 'Lyon' })
      .expect(201);
    expect(create.body.id).toBeTruthy();
    expect(create.body.name).toBe('Nouvelle SARL');
  });

  test('un admin crée un client (all_customers, sans ligne d’accès) → 201', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('x-lsi-session', 'sess-admin')
      .send({ name: 'Admin Client SA' })
      .expect(201);
    expect(create.body.name).toBe('Admin Client SA');
  });

  test('SIREN dupliqué dans le tenant → 409', async () => {
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'A', siren: '999999999' }).expect(201);
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'B', siren: '999999999' }).expect(409);
  });

  test('SIREN mal formé → 400', async () => {
    await request(app.getHttpServer()).post('/v1/customers').set('x-lsi-session', 'sess-admin')
      .send({ name: 'C', siren: '12' }).expect(400);
  });
});
