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
let versionId: string;

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
  const r = await request(app.getHttpServer())
    .put(`/v1/contracts/${fx.customerA.contractId}/content`)
    .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Contenu A</p>' });
  versionId = r.body.id;
});

describe('GET versions', () => {
  test('liste les versions du contrat', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/versions`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.items.some((v: any) => v.id === versionId)).toBe(true);
    expect(res.body.items[0].versionNumber).toBeGreaterThanOrEqual(1);
  });

  test('lit le contenu d\'une version', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/versions/${versionId}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.body.bodyHtml).toContain('Contenu A');
  });

  test('IDOR : versions du contrat de B → 404', async () => {
    await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerB.contractId}/versions`).set('x-lsi-session', 'sess-am-a').expect(404);
  });
});
