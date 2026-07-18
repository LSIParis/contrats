import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

async function reminderFor(customerId: string, contractRef: string) {
  const contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId, tenantId: fx.tenantId, customerId, reference: contractRef,
        title: 'C', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
        currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.reminder.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId, contractId,
        kind: 'EXPIRY', offsetDays: 30, cycle: 0, dueAt: now, status: 'PENDING', createdAt: now,
      },
    });
  });
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
  await reminderFor(fx.customerA.id, 'LSI-REM-A');
  await reminderFor(fx.customerB.id, 'LSI-REM-B');
});

describe('GET /v1/reminders', () => {
  test("scopé : l'AM de A ne voit que les rappels de A", async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reminders?status=PENDING')
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    const refs = res.body.items.map((r: any) => r.contractReference);
    expect(refs).toContain('LSI-REM-A');
    expect(refs).not.toContain('LSI-REM-B');
  });

  test('status invalide : 400, pas un 500 PrismaClientValidationError', async () => {
    await request(app.getHttpServer())
      .get('/v1/reminders?status=NOT_A_STATUS')
      .set('x-lsi-session', 'sess-am-a')
      .expect(400);
  });
});
