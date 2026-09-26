import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, clientScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Feature flags et paramètres par tenant (lot 0).
 *
 * Exigence du brief : contrats.ai.enabled, contrats.docuseal.enabled et
 * contrats.api.enabled sont DÉSACTIVÉS par défaut, par tenant.
 */
let app: INestApplication;
let t1: TwoCustomerFixture;
let t2: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  t1 = await seedTwoCustomers();
  t2 = await seedTwoCustomers(); // un SECOND tenant, pour l'isolation
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ff-admin-1', userId: t1.adminUserId, tenantId: t1.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t1.tenantId, t1.adminUserId) });
  await s.put({ sessionId: 'ff-admin-2', userId: t2.adminUserId, tenantId: t2.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t2.tenantId, t2.adminUserId) });
  await s.put({ sessionId: 'ff-am-1', userId: t1.amUserId, tenantId: t1.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(t1.tenantId, [t1.customerA.id], t1.amUserId) });
  await s.put({ sessionId: 'ff-client-1', userId: t1.customerA.clientUserId, tenantId: t1.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(t1.tenantId, t1.customerA.id, t1.customerA.clientUserId) });
});

const http = () => request(app.getHttpServer());

describe('feature flags', () => {
  test('les trois drapeaux du brief sont désactivés par défaut', async () => {
    const res = await http().get('/v1/feature-flags').set('x-lsi-session', 'ff-am-1').expect(200);
    expect(res.body.flags).toMatchObject({
      'contrats.ai.enabled': false,
      'contrats.docuseal.enabled': false,
      'contrats.api.enabled': false,
    });
  });

  test('un admin active un drapeau ; tout interne du tenant le voit', async () => {
    await http().put('/v1/admin/feature-flags/contrats.ai.enabled').set('x-lsi-session', 'ff-admin-1')
      .send({ enabled: true }).expect(200);
    const res = await http().get('/v1/feature-flags').set('x-lsi-session', 'ff-am-1').expect(200);
    expect(res.body.flags['contrats.ai.enabled']).toBe(true);
  });

  test('isolation multi-tenant : le drapeau du tenant 1 n’active rien chez le tenant 2', async () => {
    await http().put('/v1/admin/feature-flags/contrats.api.enabled').set('x-lsi-session', 'ff-admin-1')
      .send({ enabled: true }).expect(200);
    const res = await http().get('/v1/feature-flags').set('x-lsi-session', 'ff-admin-2').expect(200);
    expect(res.body.flags['contrats.api.enabled']).toBe(false);
    expect(res.body.flags['contrats.ai.enabled']).toBe(false);
  });

  test('un commercial ne peut pas modifier un drapeau (403)', async () => {
    await http().put('/v1/admin/feature-flags/contrats.ai.enabled').set('x-lsi-session', 'ff-am-1')
      .send({ enabled: false }).expect(403);
  });

  test('drapeau inconnu → 400 (pas de création de clé arbitraire)', async () => {
    await http().put('/v1/admin/feature-flags/contrats.bidon.enabled').set('x-lsi-session', 'ff-admin-1')
      .send({ enabled: true }).expect(400);
  });

  test('corps invalide → 400, champ inconnu refusé', async () => {
    await http().put('/v1/admin/feature-flags/contrats.ai.enabled').set('x-lsi-session', 'ff-admin-1')
      .send({ enabled: 'oui' }).expect(400);
    await http().put('/v1/admin/feature-flags/contrats.ai.enabled').set('x-lsi-session', 'ff-admin-1')
      .send({ enabled: true, tenantId: t2.tenantId }).expect(400);
  });

  test('une session client n’a pas accès à l’API interne des drapeaux', async () => {
    await http().get('/v1/feature-flags').set('x-lsi-session', 'ff-client-1').expect(403);
  });
});

describe('paramètres du tenant', () => {
  test('valeurs par défaut documentées quand rien n’est enregistré', async () => {
    const res = await http().get('/v1/admin/settings').set('x-lsi-session', 'ff-admin-2').expect(200);
    expect(res.body.settings).toMatchObject({
      'ai.provider': 'perplexity',
      'alerts.thresholdsDays': [90, 60, 30, 7],
      'pricing.rounding': 'HALF_AWAY_FROM_ZERO',
      'signature.defaultOrder': 'CLIENT_FIRST',
    });
  });

  test('écriture validée par le schéma de la clé', async () => {
    await http().put('/v1/admin/settings/alerts.thresholdsDays').set('x-lsi-session', 'ff-admin-1')
      .send({ value: [120, 30] }).expect(200);
    const res = await http().get('/v1/admin/settings').set('x-lsi-session', 'ff-admin-1').expect(200);
    expect(res.body.settings['alerts.thresholdsDays']).toEqual([120, 30]);

    await http().put('/v1/admin/settings/alerts.thresholdsDays').set('x-lsi-session', 'ff-admin-1')
      .send({ value: [-5] }).expect(400);
    await http().put('/v1/admin/settings/ai.provider').set('x-lsi-session', 'ff-admin-1')
      .send({ value: 'openai' }).expect(400);
    await http().put('/v1/admin/settings/cle.inconnue').set('x-lsi-session', 'ff-admin-1')
      .send({ value: 1 }).expect(400);
  });

  test('les paramètres sont réservés à l’admin', async () => {
    await http().get('/v1/admin/settings').set('x-lsi-session', 'ff-am-1').expect(403);
  });

  test('isolation : le paramètre du tenant 1 ne fuit pas vers le tenant 2', async () => {
    const res = await http().get('/v1/admin/settings').set('x-lsi-session', 'ff-admin-2').expect(200);
    expect(res.body.settings['alerts.thresholdsDays']).toEqual([90, 60, 30, 7]);
  });
});
