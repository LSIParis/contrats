import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  await sessions.put({
    sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('PUT /v1/contracts/:id/content', () => {
  test('enregistre une version, incrémente le numéro, pose currentVersionId, assainit', async () => {
    const r1 = await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a')
      .send({ bodyHtml: '<p>Bonjour</p><script>alert(1)</script>', changeSummary: 'init' })
      .expect(200);
    expect(r1.body.versionNumber).toBe(1);

    const r2 = await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a')
      .send({ bodyHtml: '<p>Deuxième</p>' })
      .expect(200);
    expect(r2.body.versionNumber).toBe(2);

    const [contract, version] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: fx.customerA.contractId }, select: { currentVersionId: true } }),
      await tx.contractVersion.findUnique({ where: { id: r1.body.id }, select: { bodyHtml: true } }),
    ]);
    expect(contract!.currentVersionId).toBe(r2.body.id);
    expect(version!.bodyHtml).toContain('Bonjour');
    expect(version!.bodyHtml).not.toContain('<script>'); // assaini
  });

  test('rôle insuffisant (TECHNICIAN) → 403', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-tech').send({ bodyHtml: '<p>x</p>' }).expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerB.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>x</p>' }).expect(404);
  });
});
