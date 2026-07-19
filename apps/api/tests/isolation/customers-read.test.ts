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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('GET /v1/customers', () => {
  test('scopé : l\'AM de A voit A, pas B', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/customers').set('x-lsi-session', 'sess-am-a').expect(200);
    const ids = res.body.items.map((c: any) => c.id);
    expect(ids).toContain(fx.customerA.id);
    expect(ids).not.toContain(fx.customerB.id);
    expect(typeof res.body.items[0].contractCount).toBe('number');
  });
});

describe('GET /v1/customers/:id', () => {
  test('fiche du client de A', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/customers/${fx.customerA.id}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.customer.id).toBe(fx.customerA.id);
    expect(Array.isArray(res.body.contacts)).toBe(true);
  });

  test('IDOR : le client de B → 404 (jamais 403)', async () => {
    await request(app.getHttpServer())
      .get(`/v1/customers/${fx.customerB.id}`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
