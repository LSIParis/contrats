import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { FakeProvider } from '../support/fakes.js';
import { adminScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Signature intégrée (brief §7, embed_src) : chacun n'obtient QUE son propre
 * lien de signature, rapproché par l'e-mail de sa session.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
let contractId: string;
const signerEmail = `signataire-${Date.now()}@lsi.fr`;

beforeAll(async () => {
  process.env.DOCUSEAL_SIGN_URL = 'https://signe.example.fr';
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ESIGNATURE_PROVIDER).useValue(new FakeProvider())
    .compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  const admin = adminScope(fx.tenantId, fx.adminUserId);
  const signerId = uuidv7();
  contractId = uuidv7();
  const now = new Date();
  await withScope(admin, async (tx) => {
    await tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled', enabled: true, updatedAt: now } });
    await tx.user.create({ data: { id: signerId, tenantId: fx.tenantId, kind: 'INTERNAL', email: signerEmail, fullName: 'Signataire LSI', createdAt: now, updatedAt: now } });
    await tx.contract.create({ data: {
      id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `EMB-${contractId.slice(-12)}`, title: 'Intégrée',
      type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
      ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
    } });
    await tx.contractSigner.createMany({ data: [
      { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'LSI', fullName: 'Signataire LSI', email: signerEmail.toUpperCase(), status: 'SENT', providerSubmitterSlug: 'slug-lsi', createdAt: now, updatedAt: now },
      { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, party: 'CLIENT', fullName: 'Client', email: fx.customerA.clientEmail, status: 'SENT', providerSubmitterSlug: 'slug-client', createdAt: now, updatedAt: now },
    ] });
  });
  const s = app.get(SessionService);
  await s.put({ sessionId: 'emb-signer', userId: signerId, tenantId: fx.tenantId, roles: ['INTERNAL_SIGNATORY'], scope: adminScope(fx.tenantId, signerId) });
  await s.put({ sessionId: 'emb-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: admin });
  await s.put({ sessionId: 'emb-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: admin });
  await s.put({ sessionId: 'emb-client', userId: fx.customerA.clientUserId, tenantId: fx.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId) });
});
const http = () => request(app.getHttpServer());

describe('signature intégrée', () => {
  test('le signataire interne obtient SON lien (e-mail rapproché sans tenir compte de la casse)', async () => {
    const r = await http().get(`/v1/contracts/${contractId}/signing`).set('x-lsi-session', 'emb-signer').expect(200);
    expect(r.body).toEqual({ alreadySigned: false, embedSrc: 'https://signe.example.fr/s/slug-lsi' });
  });

  test('un admin qui n’est pas signataire n’obtient aucun lien (404), un commercial n’a pas le droit (403)', async () => {
    await http().get(`/v1/contracts/${contractId}/signing`).set('x-lsi-session', 'emb-admin').expect(404);
    await http().get(`/v1/contracts/${contractId}/signing`).set('x-lsi-session', 'emb-am').expect(403);
  });

  test('le client obtient le lien du signataire CLIENT, jamais celui de LSI', async () => {
    const r = await http().get(`/v1/portal/contracts/${contractId}/signing`).set('x-lsi-session', 'emb-client').expect(200);
    expect(r.body.embedSrc).toBe('https://signe.example.fr/s/slug-client');
  });

  test('signature neutralisée (drapeau coupé) → 503, et la disponibilité est exposée à l’interface', async () => {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.tenantFeatureFlag.update({
      where: { tenantId_key: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled' } }, data: { enabled: false } }));
    await http().get(`/v1/contracts/${contractId}/signing`).set('x-lsi-session', 'emb-signer').expect(503);
    const a = await http().get('/v1/signature/availability').set('x-lsi-session', 'emb-am').expect(200);
    expect(a.body).toMatchObject({ configured: false, enabled: false });
  });
});
