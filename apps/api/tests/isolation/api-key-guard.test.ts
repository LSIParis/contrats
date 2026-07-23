import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

const KEY = 'test-service-key-0123456789abcdef';
let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  process.env.CONTRACT_SERVICE_API_KEY = KEY;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  // Le tenant de service se résout via DEFAULT_TENANT_SLUG → aligner sur le tenant seedé.
  process.env.DEFAULT_TENANT_SLUG = fx.tenantSlug;
});

const withKey = (path: string, key: string) =>
  request(app.getHttpServer()).get(path).set('x-api-key', key);

describe('API-key de service — lecture des contrats en serveur-à-serveur', () => {
  test('clé valide, sans session → 200, voit les contrats de TOUS les customers (allCustomers)', async () => {
    const res = await withKey('/v1/contracts', KEY).expect(200);
    const ids = (res.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(fx.customerA.contractId);
    expect(ids).toContain(fx.customerB.contractId);
  });

  test('clé invalide → 401', async () => {
    await withKey('/v1/contracts', 'mauvaise-cle').expect(401);
  });

  test('ni session ni clé → 401', async () => {
    await request(app.getHttpServer()).get('/v1/contracts').expect(401);
  });

  test('clé valide sur findOne (@ServiceReadable) → 200', async () => {
    await withKey(`/v1/contracts/${fx.customerA.contractId}`, KEY).expect(200);
  });

  test('clé valide sur une route NON @ServiceReadable → 401', async () => {
    await withKey(`/v1/contracts/${fx.customerA.contractId}/allowed-actions`, KEY).expect(401);
  });
});
