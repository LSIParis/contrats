import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, clientScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am',
    userId: fx.amUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  await sessions.put({
    sessionId: 'sess-client',
    userId: fx.customerA.clientUserId,
    tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'],
    scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId),
  });
});

describe('GET /v1/auth/me', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).get('/v1/auth/me').expect(401);
  });

  test('utilisateur interne : identité + rôles', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-lsi-session', 'sess-am')
      .expect(200);
    expect(res.body.userId).toBe(fx.amUserId);
    expect(res.body.email).toBe(fx.amEmail);
    expect(res.body.kind).toBe('INTERNAL');
    expect(res.body.roles).toContain('ACCOUNT_MANAGER');
    expect(res.body.customerId ?? null).toBeNull();
  });

  test('utilisateur client : /v1/auth/me est interne → 403 (garde deny-by-default, Task 2)', async () => {
    // Une session CLIENT n'atteint jamais la surface interne, même en
    // lecture — /v1/auth/me est hors /v1/portal/*. L'équivalent client est
    // GET /v1/portal/me (voir portal-contracts.test.ts).
    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-lsi-session', 'sess-client')
      .expect(403);
  });
});
