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
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  // Contrat directement en APPROVED avec une version approuvée.
  contractId = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: { id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AP-${contractId.slice(-8)}`, title: 'AP', type: 'MAIN', status: 'APPROVED', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    const v = await tx.contractVersion.create({ data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, versionNumber: 1, bodyHtml: '<p>v1</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId }, select: { id: true } });
    await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id, approvedVersionId: v.id } });
  });
});

describe('RM-11 — édition rouvre un approuvé', () => {
  test('éditer un contrat APPROVED le repasse en DRAFT (approvedVersionId nul)', async () => {
    await request(app.getHttpServer()).put(`/v1/contracts/${contractId}/content`).set('x-lsi-session', 'sess-am').send({ bodyHtml: '<p>v2</p>' }).expect(200);
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id: contractId }, select: { status: true, approvedVersionId: true } }));
    expect(c!.status).toBe('DRAFT');
    expect(c!.approvedVersionId).toBeNull();
  });
});
