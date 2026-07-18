import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, withScope, adminScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
const DAY = 86_400_000;

async function activeContract(customerId: string, endInDays: number) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId,
        reference: `LSI-${id.slice(-8)}`, title: 'Contrat', type: 'MAIN',
        status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, startDate: new Date(now.getTime() - 300 * DAY),
        endDate: new Date(now.getTime() + endInDays * DAY),
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    }),
  );
  return id;
}

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
  await activeContract(fx.customerA.id, 20); // j30 de A
  await activeContract(fx.customerA.id, 50); // j60 de A
  await activeContract(fx.customerB.id, 20); // j30 de B — NE DOIT PAS apparaître pour l'AM de A
});

describe('GET /v1/dashboard', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).get('/v1/dashboard').expect(401);
  });

  test('les échéances sont scopées au portefeuille', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/dashboard')
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    // AM de A voit ses 2 contrats ACTIVE (j30 + j60), jamais celui de B.
    const all = [...res.body.expiring.j30, ...res.body.expiring.j60, ...res.body.expiring.j90];
    expect(all).toHaveLength(2);
    expect(res.body.expiring.j30).toHaveLength(1);
    expect(res.body.expiring.j60).toHaveLength(1);
    expect(res.body.countsByStatus.ACTIVE).toBe(2); // pas 3 : B est hors scope
  });
});
