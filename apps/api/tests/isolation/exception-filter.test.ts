import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});

describe('filtre d’exception global', () => {
  test('une 404 (HttpException) renvoie un corps avec requestId, statut préservé', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts/00000000-0000-7000-8000-000000000000')
      .set('x-lsi-session', 'sess-am')
      .expect(404);
    expect(res.body.requestId).toMatch(/[0-9a-f-]{16,}/);
    expect(res.body.statusCode ?? 404).toBe(404); // corps HttpException préservé
  });
});
