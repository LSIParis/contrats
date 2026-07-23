import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post'|'put', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

async function newTemplate(name = 'Maintenance standard') {
  const res = await req('sess-admin', 'post', '/v1/templates').send({ name, category: 'MAINTENANCE' }).expect(201);
  return res.body.id as string;
}

describe('bibliothèque de modèles', () => {
  test('création → DRAFT avec une version 1 vide, listée', async () => {
    const id = await newTemplate();
    const detail = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'DRAFT' });
    expect(detail.body.currentVersion.versionNumber).toBe(1);
    expect(detail.body.currentVersion.isImmutable).toBe(false);
    const list = await req('sess-admin', 'get', '/v1/templates').expect(200);
    expect(list.body.items.some((t: any) => t.id === id)).toBe(true);
  });

  test('enregistrement : sanitise + extrait les variables des placeholders', async () => {
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`)
      .send({ bodyHtml: '<p>Client {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>' }).expect(200);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.currentVersion.bodyHtml).not.toContain('<script>');
    const props = d.body.currentVersion.variablesSchema?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['client_nom', 'montant']);
  });

  test('publication fige la version et refuse un corps vide', async () => {
    const empty = await newTemplate();
    await req('sess-admin', 'post', `/v1/templates/${empty}/publish`).expect(400); // corps vide
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>Corps</p>' }).expect(200);
    await req('sess-admin', 'post', `/v1/templates/${id}/publish`).expect(201);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.status).toBe('PUBLISHED');
    expect(d.body.currentVersion.isImmutable).toBe(true);
    expect(d.body.currentVersion.publishedAt).not.toBeNull();
  });

  test('ré-édition après publication crée une nouvelle version DRAFT (v+1)', async () => {
    const id = await newTemplate();
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>v1</p>' }).expect(200);
    await req('sess-admin', 'post', `/v1/templates/${id}/publish`).expect(201);
    await req('sess-admin', 'put', `/v1/templates/${id}/content`).send({ bodyHtml: '<p>v2</p>' }).expect(200);
    const d = await req('sess-admin', 'get', `/v1/templates/${id}`).expect(200);
    expect(d.body.currentVersion.versionNumber).toBe(2);
    expect(d.body.currentVersion.isImmutable).toBe(false);
    expect(d.body.versions.length).toBe(2);
  });

  test('rôle non autorisé (ACCOUNT_MANAGER) → 403 ; modèle inexistant → 404', async () => {
    await req('sess-am', 'get', '/v1/templates').expect(403);
    await req('sess-admin', 'get', '/v1/templates/00000000-0000-7000-8000-000000000000').expect(404);
  });
});
