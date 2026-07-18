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
let contractId: string;

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
  await sessions.put({
    sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId),
  });

  contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id,
        reference: 'LSI-DETAIL-1', title: 'Contrat détail', type: 'MAIN',
        status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, signedAt: now, activatedAt: now,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.contractSigner.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId,
        party: 'CLIENT', fullName: 'J. Dupont', email: 'jd@dupont.fr',
        signingOrder: 1, status: 'SIGNED', signedAt: now, createdAt: now, updatedAt: now,
      },
    });
    await tx.reminder.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId,
        kind: 'EXPIRY', offsetDays: 30, cycle: 0, dueAt: now, status: 'PENDING', createdAt: now,
      },
    });
  });
});

describe('GET /v1/contracts/:id enrichi', () => {
  test('renvoie contrat, signataires, rappels et timeline', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${contractId}`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    expect(res.body.contract.reference).toBe('LSI-DETAIL-1');
    expect(res.body.customer.name).toBeTruthy();
    expect(res.body.signatureRequest?.signers ?? []).toBeInstanceOf(Array);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.timeline.length).toBeGreaterThanOrEqual(1);
  });

  test('IDOR : l’AM de B reçoit 404, jamais 403', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${contractId}`)
      .set('x-lsi-session', 'sess-am-b')
      .expect(404);
  });
});
