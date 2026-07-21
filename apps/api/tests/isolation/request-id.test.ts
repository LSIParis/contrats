import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-RQ-${id.slice(-8)}`,
    title: 'ReqId', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});

describe('request-id', () => {
  test('une réponse porte un en-tête x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{16,}/);
  });

  test('un x-request-id entrant est conservé', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('x-request-id', 'trace-abc-123').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  test('une mutation auditée renseigne audit_logs.request_id', async () => {
    const c = await seedContract();
    await request(app.getHttpServer()).post(`/v1/contracts/${c}/comments`)
      .set('x-lsi-session', 'sess-am').set('x-request-id', 'trace-audit-xyz')
      .send({ body: 'tracé', visibility: 'INTERNAL' }).expect(201);
    // best-effort fire-and-forget : on attend l'entrée
    let reqId: string | null = null;
    for (let i = 0; i < 40 && !reqId; i++) {
      const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$queryRaw<{ request_id: string | null }[]>`
          SELECT request_id FROM audit_logs WHERE tenant_id=${fx.tenantId}::uuid AND action LIKE '%comments%' ORDER BY seq DESC LIMIT 1`);
      reqId = rows[0]?.request_id ?? null;
      if (!reqId) await new Promise((r) => setTimeout(r, 50));
    }
    expect(reqId).toBe('trace-audit-xyz');
  });
});
