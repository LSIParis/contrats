import { describe, test, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { REDIS } from '../../src/auth/redis.provider.js';

describe('readiness', () => {
  test('/health reste un liveness léger', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    await app.close();
  });

  test('/health/ready → 200 avec checks quand tout répond', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { db: true, redis: true } });
    await app.close();
  });

  test('/health/ready → 503 si Redis ne répond pas', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS)
      .useValue({ ping: async () => { throw new Error('redis down'); } })
      .compile();
    const app = mod.createNestApplication(); await app.init();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { redis: false } });
    await app.close();
  });
});
