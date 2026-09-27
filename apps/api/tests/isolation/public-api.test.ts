import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { PublicApiController } from '../../src/public-api/public-api.controller.js';
import { OPERATIONS } from '../../src/public-api/openapi.js';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/** Lot 7 — API publique /api/v1 (brief §8, 07-api.md). */
let app: INestApplication;
let fx: TwoCustomerFixture;
let other: TwoCustomerFixture;
let otherContract: string;
const contracts: string[] = [];
const http = () => request(app.getHttpServer());
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
let fullKey = '';

async function seedContract(f: TwoCustomerFixture, customerId: string, over: Record<string, unknown> = {}) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: f.tenantId, customerId, reference: `API-${id.slice(-12)}`, title: 'Maintenance', type: 'MAIN', status: 'ACTIVE',
    category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: f.amUserId,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), renewalMode: 'TACIT', renewalPeriodMonths: 12, noticePeriodMonths: 3,
    createdAt: now, updatedAt: now, createdByUserId: f.amUserId, updatedByUserId: f.amUserId, ...over,
  } }));
  return id;
}

async function flag(f: TwoCustomerFixture, enabled: boolean) {
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) => tx.tenantFeatureFlag.upsert({
    where: { tenantId_key: { tenantId: f.tenantId, key: 'contrats.api.enabled' } },
    create: { tenantId: f.tenantId, key: 'contrats.api.enabled', enabled, updatedAt: new Date() },
    update: { enabled },
  }));
}

async function createClient(scopes: string[], rateLimitPerMinute = 120) {
  const r = await http().post('/v1/admin/api-clients').set('x-lsi-session', 'api-admin')
    .send({ name: `Suite ${uuidv7().slice(-6)}`, scopes, rateLimitPerMinute }).expect(201);
  return r.body as { id: string; apiKey: string };
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.customer.update({ where: { id: fx.customerA.id }, data: { externalRef: `CH-${fx.tenantId.slice(-6)}`, siren: '552100554' } }));
  for (let i = 0; i < 3; i++) contracts.push(await seedContract(fx, fx.customerA.id));
  await seedContract(fx, fx.customerA.id, { status: 'DRAFT' });
  otherContract = await seedContract(other, other.customerA.id);
  await flag(fx, true);
  await flag(other, true);
  const s = app.get(SessionService);
  await s.put({ sessionId: 'api-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'api-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: adminScope(fx.tenantId, fx.amUserId) });
  fullKey = (await createClient(['contracts:read', 'contracts:dates:read', 'pricing:read', 'pricing:quote', 'webhooks:manage'])).apiKey;
});

describe('clients d’API (administration)', () => {
  test('clé renvoyée une seule fois, jamais relisible ; réservé à l’admin', async () => {
    expect(fullKey).toMatch(/^ctr_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const list = await http().get('/v1/admin/api-clients').set('x-lsi-session', 'api-admin').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(fullKey.split('_')[2]);
    expect(list.body[0]).not.toHaveProperty('keyHash');
    await http().get('/v1/admin/api-clients').set('x-lsi-session', 'api-am').expect(403);
  });
});

describe('authentification et erreurs RFC 9457', () => {
  test('sans clé / clé invalide → 401 problem+json', async () => {
    const r = await http().get(`/api/v1/contracts/${contracts[0]}`).expect(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', title: expect.any(String), instance: expect.stringMatching(/^urn:request:/) });
    const bad = await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(`${fullKey.slice(0, -2)}xx`)).expect(401);
    expect(bad.body.code).toBe('INVALID_API_KEY');
  });

  test('une session ou la clé de service historique n’ouvrent pas /api/v1', async () => {
    await http().get(`/api/v1/contracts/${contracts[0]}`).set('x-lsi-session', 'api-admin').expect(401);
  });

  test('scope manquant → 403 INSUFFICIENT_SCOPE', async () => {
    const { apiKey } = await createClient(['contracts:read']);
    const r = await http().get(`/api/v1/contracts/${contracts[0]}/dates`).set(bearer(apiKey)).expect(403);
    expect(r.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE', requiredScopes: ['contracts:dates:read'] });
  });

  test('API désactivée pour le tenant → 403 API_DISABLED', async () => {
    await flag(fx, false);
    try {
      const r = await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(fullKey)).expect(403);
      expect(r.body.code).toBe('API_DISABLED');
    } finally {
      await flag(fx, true);
    }
  });

  test('clé révoquée → 401 ; rotation : l’ancienne clé cesse, la nouvelle marche', async () => {
    const c = await createClient(['contracts:read']);
    const rot = await http().post(`/v1/admin/api-clients/${c.id}/rotate`).set('x-lsi-session', 'api-admin').expect(201);
    await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(c.apiKey)).expect(401);
    await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(rot.body.apiKey)).expect(200);
    await http().post(`/v1/admin/api-clients/${c.id}/revoke`).set('x-lsi-session', 'api-admin').expect(201);
    await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(rot.body.apiKey)).expect(401);
  });

  test('débit par client → 429 avec Retry-After', async () => {
    const { apiKey } = await createClient(['contracts:read'], 2);
    await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(apiKey)).expect(200);
    await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(apiKey)).expect(200);
    const r = await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(apiKey)).expect(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body.code).toBe('RATE_LIMITED');
  });
});

describe('lectures', () => {
  test('contrats d’un client par UUID, SIREN ou référence externe ; filtre ; pagination par curseur', async () => {
    const all = await http().get(`/api/v1/clients/${fx.customerA.id}/contracts?status=ACTIVE`).set(bearer(fullKey)).expect(200);
    const active = all.body.data.map((c: { id: string }) => c.id) as string[];
    expect(active).toEqual(expect.arrayContaining(contracts));
    expect(all.body.nextCursor).toBeNull();
    const bySiren = await http().get('/api/v1/clients/552100554/contracts').set(bearer(fullKey)).expect(200);
    expect(bySiren.body.data.length).toBeGreaterThan(active.length);
    await http().get(`/api/v1/clients/CH-${fx.tenantId.slice(-6)}/contracts`).set(bearer(fullKey)).expect(200);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const pg: request.Response = await http().get(`/api/v1/clients/${fx.customerA.id}/contracts?status=ACTIVE&limit=2${cursor ? `&cursor=${cursor}` : ''}`).set(bearer(fullKey)).expect(200);
      expect(pg.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...pg.body.data.map((c: { id: string }) => c.id));
      cursor = pg.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(active);
    const bad = await http().get(`/api/v1/clients/${fx.customerA.id}/contracts?cursor=zz`).set(bearer(fullKey)).expect(400);
    expect(bad.body.code).toBe('INVALID_CURSOR');
  });

  test('détail et dates clés', async () => {
    const c = await http().get(`/api/v1/contracts/${contracts[0]}`).set(bearer(fullKey)).expect(200);
    expect(c.body).toMatchObject({ id: contracts[0], status: 'ACTIVE', origin: 'NATIVE', signatureMode: null, customer: { id: fx.customerA.id, siren: '552100554' } });
    const d = await http().get(`/api/v1/contracts/${contracts[0]}/dates`).set(bearer(fullKey)).expect(200);
    expect(d.body).toMatchObject({ effectiveDate: '2026-01-01', currentPeriodEnd: '2026-12-31', noticeDeadline: '2026-09-30', nextRenewal: '2027-01-01', renewalMode: 'TACIT' });
  });

  test('ETag / If-None-Match → 304', async () => {
    const r1 = await http().get(`/api/v1/contracts/${contracts[1]}`).set(bearer(fullKey)).expect(200);
    expect(r1.headers.etag).toBeDefined();
    await http().get(`/api/v1/contracts/${contracts[1]}`).set(bearer(fullKey)).set('If-None-Match', r1.headers.etag!).expect(304);
  });

  test('isolation : un contrat d’un autre tenant n’existe pas (404), ni son client', async () => {
    const r = await http().get(`/api/v1/contracts/${otherContract}`).set(bearer(fullKey)).expect(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
    await http().get(`/api/v1/clients/${other.customerA.id}/contracts`).set(bearer(fullKey)).expect(404);
  });

  test('échéances : fenêtre, pagination, validation', async () => {
    await http().post('/v1/admin/deadlines/recompute').set('x-lsi-session', 'api-admin').send({});
    const r = await http().get('/api/v1/deadlines?from=2026-01-01&to=2026-12-31&limit=1').set(bearer(fullKey)).expect(200);
    expect(r.body).toHaveProperty('nextCursor');
    await http().get('/api/v1/deadlines?from=2026-01-01&to=2028-01-01').set(bearer(fullKey)).expect(400);
  });

  test('chaque appel est journalisé (route, statut), sans corps', async () => {
    await http().get(`/api/v1/contracts/${contracts[2]}`).set(bearer(fullKey)).expect(200);
    await new Promise((r) => setTimeout(r, 200));
    const log = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.apiCallLog.findFirst({ where: { route: '/api/v1/contracts/:id', status: 200 }, orderBy: { createdAt: 'desc' } }));
    expect(log).toMatchObject({ method: 'GET', route: '/api/v1/contracts/:id', status: 200 });
  });
});

describe('OpenAPI 3.1', () => {
  test('servie sans authentification ; chaque route du contrôleur y est décrite', async () => {
    const r = await http().get('/api/v1/openapi.json').expect(200);
    expect(r.body.openapi).toBe('3.1.0');
    const proto = PublicApiController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== 'constructor')
      .map((n) => {
        const h = proto[n] as object;
        const path = Reflect.getMetadata('path', h) as string;
        const method = ['get', 'post', 'put', 'delete', 'patch'][Reflect.getMetadata('method', h) as number];
        return `${method} /api/v1/${path.replace(/:(\w+)/g, '{$1}')}`;
      });
    const documented = OPERATIONS.map((o) => `${o.method} ${o.path}`);
    expect(routes.sort(), JSON.stringify(routes)).toEqual([...documented].sort());
    for (const o of OPERATIONS) expect(r.body.paths[o.path][o.method]).toBeDefined();
    const docs = await http().get('/api/v1/docs').expect(200);
    expect(docs.text).toContain('listClientContracts');
  });
});
