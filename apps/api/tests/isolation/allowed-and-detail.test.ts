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
  contractId = fx.customerA.contractId; // DRAFT, sans contenu ni signataires au départ
});

describe('allowedActions + findOne', () => {
  test('sans signataires ni contenu : allowed-actions ne contient pas SUBMIT_FOR_REVIEW', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}/allowed-actions`).set('x-lsi-session', 'sess-am').expect(200);
    expect(res.body.allowedActions).not.toContain('SUBMIT_FOR_REVIEW');
  });

  test('avec contenu + signataires + date : SUBMIT_FOR_REVIEW apparaît ; findOne renvoie signers + approval', async () => {
    const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      const v = await tx.contractVersion.create({ data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId }, select: { id: true } });
      await tx.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id, startDate: new Date('2026-08-01') } });
      await tx.contractSigner.createMany({ data: [
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'LSI', fullName: 'M', email: 'm@lsi.fr', signingOrder: 0, createdAt: now, updatedAt: now },
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'CLIENT', fullName: 'J', email: 'j@c.fr', signingOrder: 1, createdAt: now, updatedAt: now },
      ]});
    });
    const allowed = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}/allowed-actions`).set('x-lsi-session', 'sess-am').expect(200);
    expect(allowed.body.allowedActions).toContain('SUBMIT_FOR_REVIEW');

    const detail = await request(app.getHttpServer()).get(`/v1/contracts/${contractId}`).set('x-lsi-session', 'sess-am').expect(200);
    expect(detail.body.signers).toHaveLength(2);
    expect(detail.body.signers[0]).toHaveProperty('email');
    expect(detail.body).toHaveProperty('approval'); // null tant que non soumis
  });
});
