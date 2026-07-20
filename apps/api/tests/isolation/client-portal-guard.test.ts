import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { clientScope, internalScope, uuidv7, adminScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let clientUserId: string;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();

  // Un utilisateur CLIENT rattaché au customerA (kind CLIENT).
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: 'client-guard@example.com', fullName: 'Nathalie Client', status: 'ACTIVE',
    createdAt: new Date(), updatedAt: new Date() } }));

  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_VIEWER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId),
  }, 1800);
  await sessions.put({
    sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

const get = (path: string, sess: string) =>
  request(app.getHttpServer()).get(path).set('x-lsi-session', sess);

describe('ClientPortalGuard — deny-by-default pour les sessions CLIENT', () => {
  test('GET /v1/contracts (interne) avec une session CLIENT → 403', async () => {
    await get('/v1/contracts', 'sess-client').expect(403);
  });

  test('GET /v1/portal/contracts avec une session CLIENT → 200', async () => {
    await get('/v1/portal/contracts', 'sess-client').expect(200);
  });

  test('GET /v1/contracts avec une session INTERNE (ACCOUNT_MANAGER) → 200, non impacté', async () => {
    await get('/v1/contracts', 'sess-am').expect(200);
  });
});
