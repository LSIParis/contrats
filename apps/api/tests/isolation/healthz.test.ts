import { describe, test, expect, afterEach } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { DOCUMENT_STORAGE } from '../../src/documents/document-storage.port.js';
import { InMemoryStorage } from '../../src/documents/in-memory-storage.js';

/**
 * Contrat de santé imposé par deploy.yml (annexe A) : le test de fumée
 * compare `version` et `revision` de /healthz à la version et au commit
 * déployés. Une faute de frappe ici et CHAQUE déploiement « échoue » puis se
 * replie sur la version précédente.
 */
const saved = { v: process.env.APP_VERSION, s: process.env.GIT_SHA };
afterEach(() => {
  process.env.APP_VERSION = saved.v;
  process.env.GIT_SHA = saved.s;
});

describe('/healthz (liveness, public)', () => {
  test('200 avec status, version et révision complète issues de l’environnement', async () => {
    process.env.APP_VERSION = '1.4.2';
    process.env.GIT_SHA = 'a'.repeat(40);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await createTestApp(mod);
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok', version: '1.4.2', revision: 'a'.repeat(40) });
    await app.close();
  });

  test('sans variables : valeurs explicites « dev » / « unknown », jamais undefined', async () => {
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await createTestApp(mod);
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok', version: 'dev', revision: 'unknown' });
    await app.close();
  });
});

describe('/readyz (readiness, public)', () => {
  test('200 quand base, Redis et stockage répondent', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await createTestApp(mod);
    const res = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toMatchObject({ db: true, redis: true, storage: true });
    await app.close();
  });

  test('503 si le stockage documentaire est injoignable (dépendance critique)', async () => {
    const broken = new InMemoryStorage();
    broken.ping = async () => false;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCUMENT_STORAGE).useValue(broken)
      .compile();
    const app = await createTestApp(mod);
    const res = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(res.body).toMatchObject({ status: 'unavailable', checks: { storage: false } });
    await app.close();
  });

  test('ne divulgue aucun détail d’infrastructure (URL, message d’erreur)', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await createTestApp(mod);
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(JSON.stringify(res.body)).not.toMatch(/postgres(ql)?:\/\/|redis:\/\/|https?:\/\//);
    await app.close();
  });
});
