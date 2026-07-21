import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, appendAudit } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
async function append(tenantId: string, action: string, actor: string) {
  await appendAudit({
    tenantId, customerId: null, actorUserId: actor, actorKind: 'INTERNAL',
    actorIp: null, actorUserAgent: null, action, resourceType: 'contract',
    resourceId: null, after: {}, requestId: null, occurredAt: new Date(),
  });
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('lecture du journal d’audit', () => {
  test('MSP_ADMIN liste les entrées ; un non-admin → 403', async () => {
    await append(fx.tenantId, 'READ_TEST_1', fx.adminUserId);
    const res = await req('sess-admin', 'get', '/v1/audit').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    await req('sess-am', 'get', '/v1/audit').expect(403);
  });

  test('filtre par action', async () => {
    await append(fx.tenantId, 'NEEDLE_XYZ', fx.adminUserId);
    const res = await req('sess-admin', 'get', '/v1/audit?action=NEEDLE_XYZ').expect(200);
    expect(res.body.items.every((i: any) => i.action.includes('NEEDLE_XYZ'))).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  test('verify renvoie ok:true sur une chaîne saine', async () => {
    const res = await req('sess-admin', 'get', '/v1/audit/verify').expect(200);
    expect(res.body).toMatchObject({ ok: true, brokenAt: null });
  });
});
