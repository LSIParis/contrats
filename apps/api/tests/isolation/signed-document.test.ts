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
let withProof: string;
let withoutProof: string;

async function contract(customerId: string, signedKey: string | null): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId, reference: `LSI-${id.slice(-8)}`,
        title: 'C', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
        currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    await tx.signatureRequest.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId, contractId: id, versionId: uuidv7(),
        provider: 'DOCUSEAL', status: 'COMPLETED', idempotencyKey: uuidv7(),
        signedPdfObjectKey: signedKey, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId,
      },
    });
  });
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
  withProof = await contract(
    fx.customerA.id,
    `t/${fx.tenantId}/c/${fx.customerA.id}/contracts/x/signed/y/document.pdf`,
  );
  withoutProof = await contract(fx.customerA.id, null);
});

describe('GET /v1/contracts/:id/signed-document', () => {
  test('preuve présente → { url }', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${withProof}/signed-document`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(200);
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url.length).toBeGreaterThan(0);
  });

  test('pas de preuve → 404', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${withoutProof}/signed-document`)
      .set('x-lsi-session', 'sess-am-a')
      .expect(404);
  });
});
