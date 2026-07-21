import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedContract(status: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AR-${id.slice(-8)}`,
    title: 'À archiver', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await s.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('archivage des contrats', () => {
  test('archiver un contrat terminé pose archivedAt ; il sort de la liste par défaut', async () => {
    const id = await seedContract('TERMINATED');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(201);
    const list = await req('sess-am', 'get', '/v1/contracts').expect(200);
    expect(list.body.data.some((c: any) => c.id === id)).toBe(false);
    const arch = await req('sess-am', 'get', '/v1/contracts?archived=true').expect(200);
    expect(arch.body.data.some((c: any) => c.id === id)).toBe(true);
  });

  test('archiver un contrat non terminal (ACTIVE) → 409', async () => {
    const id = await seedContract('ACTIVE');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(409);
  });

  test('désarchiver le remet dans la liste par défaut', async () => {
    const id = await seedContract('EXPIRED');
    await req('sess-am', 'post', `/v1/contracts/${id}/archive`).expect(201);
    await req('sess-am', 'post', `/v1/contracts/${id}/unarchive`).expect(201);
    const list = await req('sess-am', 'get', '/v1/contracts').expect(200);
    expect(list.body.data.some((c: any) => c.id === id)).toBe(true);
  });

  test('un rôle non autorisé (TECHNICIAN) → 403', async () => {
    const id = await seedContract('TERMINATED');
    await req('sess-tech', 'post', `/v1/contracts/${id}/archive`).expect(403);
  });

  test('la recherche matche le nom du client', async () => {
    await seedContract('ACTIVE'); // client Dupont SAS
    const res = await req('sess-am', 'get', '/v1/contracts?q=Dupont').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((c: any) => c.customer.name.includes('Dupont'))).toBe(true);
  });
});
