import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { contentSecurityPolicy } from '../../src/bootstrap.js';
import { adminScope, internalScope, withScope, setTransitionContext } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/** Points d'appui demandés par l'interface (lots 0-1) et en-têtes de sécurité. */
let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ui-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'ui-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'ui-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
});
const http = () => request(app.getHttpServer());

describe('en-têtes de sécurité posés par l’application', () => {
  test('CSP stricte (aucune origine tierce hors DocuSeal), cadres limités à la même origine', async () => {
    const res = await http().get('/healthz').expect(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toMatch(/fonts\.googleapis|cdn\./);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('l’origine DocuSeal est autorisée pour la signature intégrée, et elle seule', () => {
    const csp = contentSecurityPolicy('https://signe.example.fr/api');
    expect(csp).toContain('frame-src \'self\' blob: https://signe.example.fr');
    expect(csp).toContain('script-src \'self\' https://signe.example.fr');
    expect(contentSecurityPolicy('pas une url')).toContain("script-src 'self'");
  });
});

describe('journal des transitions', () => {
  test('liste les transitions avec événement, motif et nom de l’acteur ; 404 hors portefeuille', async () => {
    await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), async (tx) => {
      await setTransitionContext(tx, { event: 'CANCEL', reason: 'doublon' });
      await tx.contract.update({ where: { id: fx.customerA.contractId }, data: { status: 'CANCELLED' } });
    });
    const res = await http().get(`/v1/contracts/${fx.customerA.contractId}/lifecycle`).set('x-lsi-session', 'ui-am').expect(200);
    expect(res.body.items.at(-1)).toMatchObject({ from: 'DRAFT', to: 'CANCELLED', event: 'CANCEL', reason: 'doublon', actorKind: 'INTERNAL' });
    expect(res.body.items.at(-1).actor.name).toBeTruthy();
    await http().get(`/v1/contracts/${fx.customerA.contractId}/lifecycle`).set('x-lsi-session', 'ui-am-b').expect(404);
  });
});

describe('permissions de la session', () => {
  test('/v1/auth/me expose les actions autorisées (sans recopier la matrice côté client)', async () => {
    const am = await http().get('/v1/auth/me').set('x-lsi-session', 'ui-am').expect(200);
    expect(am.body.permissions).toContain('contracts.write');
    expect(am.body.permissions).not.toContain('imports.validate');
    const admin = await http().get('/v1/auth/me').set('x-lsi-session', 'ui-admin').expect(200);
    expect(admin.body.permissions).toContain('tenant.configure');
  });
});

describe('recalcul de l’échéancier à la demande', () => {
  test('réservé à l’admin', async () => {
    await http().post('/v1/admin/deadlines/recompute').set('x-lsi-session', 'ui-am').expect(403);
    const r = await http().post('/v1/admin/deadlines/recompute').set('x-lsi-session', 'ui-admin').expect(201);
    expect(r.body).toHaveProperty('contracts');
  });
});
