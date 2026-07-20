import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture; let clientUserId: string;
const CLIENT_EMAIL = 'signer-a@example.com';

async function seedSignableContract(signerStatus: string, slug: string | null) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-SG-${id.slice(-8)}`,
      title: 'À signer', type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE',
      currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    await tx.contractSigner.create({ data: {
      id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT',
      fullName: 'Nathalie', email: CLIENT_EMAIL, signingOrder: 1, status: signerStatus as any,
      providerSubmitterSlug: slug, createdAt: now, updatedAt: now } });
  });
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: CLIENT_EMAIL, fullName: 'Nathalie', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } }));
  await app.get(SessionService).put({ sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId) }, 1800);
});
const get = (path: string) => request(app.getHttpServer()).get(path).set('x-lsi-session', 'sess-client');

describe('signature in-portal', () => {
  test('la fiche expose mySignature.status pour le client', async () => {
    const id = await seedSignableContract('SENT', 'slug-abc');
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body.mySignature).toMatchObject({ status: 'SENT' });
  });

  test('/sign redirige (302) vers la page DocuSeal du signataire', async () => {
    const id = await seedSignableContract('SENT', 'slug-xyz');
    const res = await get(`/v1/portal/contracts/${id}/sign`).expect(302);
    expect(res.headers.location).toContain('/s/slug-xyz');
    // le slug n'est PAS dans le JSON de la fiche
    const detail = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain('slug-xyz');
  });

  test('déjà signé → /sign 409', async () => {
    const id = await seedSignableContract('SIGNED', 'slug-done');
    await get(`/v1/portal/contracts/${id}/sign`).expect(409);
  });

  test('client non signataire → mySignature null et /sign 404', async () => {
    // contrat sans signataire au nom du client
    const id = uuidv7(); const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-NS-${id.slice(-8)}`, title: 'X',
      type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
      ownerUserId: fx.amUserId, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body.mySignature).toBeNull();
    await get(`/v1/portal/contracts/${id}/sign`).expect(404);
  });
});
