import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

// Vraies colonnes internes du modèle Contract (packages/persistence/prisma/schema.prisma)
// qui ne doivent JAMAIS apparaître dans une réponse client — une régression
// vers `return { ...c }` doit faire échouer ce test.
const INTERNAL_CONTRACT_FIELDS = [
  'ownerUserId', 'createdByUserId', 'updatedByUserId', 'tenantId', 'customerId',
  'reminderCycle', 'parentContractId', 'predecessorContractId', 'successorContractId',
  'approvedVersionId', 'currentVersionId', 'noticePeriodDays',
] as const;

let app: INestApplication;
let fx: TwoCustomerFixture;
let clientUserId: string;

async function seedContract(status: string, cid?: string) {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: cid ?? fx.customerA.id, reference: `LSI-PORT-${id.slice(-8)}`,
    title: 'Contrat client', type: 'MAIN', status: status as any, category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', amountCents: BigInt(90000), ownerUserId: fx.amUserId,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  // Un utilisateur CLIENT rattaché au customerA (kind CLIENT).
  clientUserId = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.create({ data: {
    id: clientUserId, tenantId: fx.tenantId, kind: 'CLIENT', customerId: fx.customerA.id,
    email: 'client-a@example.com', fullName: 'Nathalie Client', status: 'ACTIVE',
    createdAt: new Date(), updatedAt: new Date() } }));
  await app.get(SessionService).put({
    sessionId: 'sess-client', userId: clientUserId, tenantId: fx.tenantId,
    roles: ['CLIENT_VIEWER'], scope: clientScope(fx.tenantId, fx.customerA.id, clientUserId),
  }, 1800);
});

const get = (path: string, sess = 'sess-client') => request(app.getHttpServer()).get(path).set('x-lsi-session', sess);

describe('GET /v1/portal/contracts', () => {
  test('liste les contrats partagés du client, sans les états internes', async () => {
    await seedContract('ACTIVE');
    await seedContract('DRAFT'); // interne, ne doit PAS apparaître
    const res = await get('/v1/portal/contracts').expect(200);
    const statuses = res.body.items.map((c: any) => c.status);
    expect(statuses).toContain('ACTIVE');
    expect(statuses).not.toContain('DRAFT');
    // projection client-safe : aucune des VRAIES colonnes internes de Contract
    for (const field of INTERNAL_CONTRACT_FIELDS) {
      expect(res.body.items[0]).not.toHaveProperty(field);
    }
    expect(res.body.items[0]).toHaveProperty('reference');
  });

  test('fiche : champs client-safe + signataires, aucun champ interne', async () => {
    const id = await seedContract('ACTIVE');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contractSigner.create({ data: {
      id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT',
      fullName: 'Nathalie Client', email: 'client-a@example.com', signingOrder: 1, status: 'SIGNED',
      signedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } }));
    const res = await get(`/v1/portal/contracts/${id}`).expect(200);
    expect(res.body).toMatchObject({ reference: expect.any(String), status: 'ACTIVE' });
    expect(res.body.signers[0]).toMatchObject({ party: 'CLIENT', status: 'SIGNED' });
    // aucune des VRAIES colonnes internes de Contract ne doit fuiter sur la fiche
    for (const field of INTERNAL_CONTRACT_FIELDS) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  test('un contrat interne (DRAFT) du client → 404 côté portail', async () => {
    const id = await seedContract('DRAFT');
    await get(`/v1/portal/contracts/${id}`).expect(404);
  });

  test('IDOR : contrat du customerB → 404', async () => {
    const id = await seedContract('ACTIVE', fx.customerB.id);
    await get(`/v1/portal/contracts/${id}`).expect(404);
  });

  test('GET /v1/portal/me → email + nom du client', async () => {
    const res = await get('/v1/portal/me').expect(200);
    expect(res.body).toMatchObject({ email: 'client-a@example.com' });
    expect(res.body.customerName).toBeTruthy();
  });
});
