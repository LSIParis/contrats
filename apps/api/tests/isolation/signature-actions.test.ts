import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { FakeProvider } from '../support/fakes.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let provider: FakeProvider;

/**
 * Un contrat en PENDING_SIGNATURE avec une demande active + 2 signataires
 * envoyés. `providerSubmissionId` et `providerSubmitterId` portent des UNIQUE
 * GLOBAUX (`@@unique([provider, providerSubmissionId])`,
 * `@@unique([providerSubmitterId])`) : on les dérive de l'`id` du contrat pour
 * qu'appeler `seedInProgress` plusieurs fois dans le même fichier ne
 * collisionne pas. `customerId` par défaut = customerA (IDOR : passer customerB).
 */
async function seedInProgress(customer: { id: string } = fx.customerA) {
  const id = uuidv7();
  const vId = uuidv7();
  const reqId = uuidv7();
  const sfx = id.slice(-12);
  const submissionId = `SUB-${sfx}`;
  const submitterIds = [`SUBM-${sfx}-0`, `SUBM-${sfx}-1`];
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({ data: {
      id, tenantId: fx.tenantId, customerId: customer.id, reference: `LSI-SIG-${sfx}`,
      title: 'S', type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE', currency: 'EUR',
      billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, currentVersionId: vId, approvedVersionId: vId,
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } });
    await tx.contractVersion.create({ data: { id: vId, tenantId: fx.tenantId, customerId: customer.id, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId } });
    await tx.signatureRequest.create({ data: {
      id: reqId, tenantId: fx.tenantId, customerId: customer.id, contractId: id, versionId: vId,
      provider: 'DOCUSEAL', providerSubmissionId: submissionId, status: 'SENT', idempotencyKey: uuidv7(),
      createdAt: now, updatedAt: now, createdByUserId: fx.amUserId } });
    await tx.contractSigner.createMany({ data: [
      { id: uuidv7(), tenantId: fx.tenantId, customerId: customer.id, contractId: id, party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0, status: 'SENT', providerSubmitterId: submitterIds[0], createdAt: now, updatedAt: now },
      { id: uuidv7(), tenantId: fx.tenantId, customerId: customer.id, contractId: id, party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1, status: 'SENT', providerSubmitterId: submitterIds[1], createdAt: now, updatedAt: now },
    ]});
  });
  return { id, reqId, submissionId, submitterIds };
}

beforeAll(async () => {
  provider = new FakeProvider();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ESIGNATURE_PROVIDER).useValue(provider).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await sessions.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
});

beforeEach(() => provider.reset());

describe('POST /v1/contracts/:id/signature/remind', () => {
  test('relance les signataires en cours via le provider', async () => {
    const { id, submitterIds } = await seedInProgress();
    const res = await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/remind`).set('x-lsi-session', 'sess-am').expect(201);
    expect(res.body.reminded).toBe(2);
    expect([...provider.reminded].sort()).toEqual([...submitterIds].sort());
  });

  test('sans demande active → 409', async () => {
    // Le contrat A initial (fx.customerA.contractId) est DRAFT, sans demande.
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signature/remind`).set('x-lsi-session', 'sess-am').expect(409);
  });

  test('IDOR : contrat de B → 404', async () => {
    const { id } = await seedInProgress();
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/remind`).set('x-lsi-session', 'sess-am-b').expect(404);
  });
});

describe('POST /v1/contracts/:id/signature/revoke', () => {
  test('révoque : provider archivé, demande REVOKED, contrat APPROVED, signataires PENDING', async () => {
    const { id, submissionId } = await seedInProgress();
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(201);
    expect(provider.revoked).toContain(submissionId);
    const [c, req, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id }, select: { status: true } }),
      await tx.signatureRequest.findFirst({ where: { contractId: id }, orderBy: { createdAt: 'desc' }, select: { status: true } }),
      await tx.contractSigner.findMany({ where: { contractId: id }, select: { status: true, providerSubmitterId: true } }),
    ]);
    expect(c!.status).toBe('APPROVED');
    expect(req!.status).toBe('REVOKED');
    expect(signers.every((s) => s.status === 'PENDING' && s.providerSubmitterId === null)).toBe(true);
  });

  test('échec provider → 502, rien ne bouge', async () => {
    const { id } = await seedInProgress();
    provider.failNext('DocuSeal indisponible');
    await request(app.getHttpServer()).post(`/v1/contracts/${id}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(502);
    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.findUnique({ where: { id }, select: { status: true } }));
    expect(c!.status).toBe('PENDING_SIGNATURE'); // inchangé
  });

  test('sans demande active → 409', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${fx.customerA.contractId}/signature/revoke`).set('x-lsi-session', 'sess-am').expect(409);
  });
});
