import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
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

describe('signataires', () => {
  test('ajoute puis supprime un signataire', async () => {
    const add = await request(app.getHttpServer())
      .post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'LSI', fullName: 'Marc D.', email: 'marc@lsi.fr', signingOrder: 0 }).expect(201);
    expect(add.body.party).toBe('LSI');
    await request(app.getHttpServer())
      .delete(`/v1/contracts/${fx.customerA.contractId}/signers/${add.body.id}`).set('x-lsi-session', 'sess-am-a').expect(204);
  });

  test('email dupliqué sur le contrat → 409', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'CLIENT', fullName: 'A', email: 'dup@x.fr' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'CLIENT', fullName: 'B', email: 'dup@x.fr' }).expect(409);
  });

  test('rôle insuffisant → 403', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signers`).set('x-lsi-session', 'sess-tech')
      .send({ party: 'LSI', fullName: 'X', email: 'x@x.fr' }).expect(403);
  });

  test('IDOR : contrat de B → 404', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerB.contractId}/signers`).set('x-lsi-session', 'sess-am-a')
      .send({ party: 'LSI', fullName: 'X', email: 'y@y.fr' }).expect(404);
  });
});
