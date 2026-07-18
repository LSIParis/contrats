import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

let app: INestApplication;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});

describe('service statique', () => {
  test('les routes /v1 ne sont pas capturées par le repli SPA', async () => {
    // Sans session → 401 (le guard répond), PAS 200 avec de l'HTML.
    const res = await request(app.getHttpServer()).get('/v1/contracts');
    expect(res.status).toBe(401);
  });

  test('/health reste public et JSON', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
