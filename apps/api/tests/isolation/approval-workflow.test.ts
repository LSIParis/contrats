import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let contractId: string;

/** Un contrat A prêt à soumettre : contenu (version) + signataires LSI+client + date. */
async function prepare(): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-WF-${id.slice(-8)}`,
        title: 'WF', type: 'MAIN', status: 'DRAFT', category: 'MAINTENANCE', currency: 'EUR',
        billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, startDate: new Date('2026-08-01'),
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    const v = await tx.contractVersion.create({
      data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id,
        versionNumber: 1, bodyHtml: '<p>Contenu</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId },
      select: { id: true },
    });
    await tx.contract.update({ where: { id }, data: { currentVersionId: v.id } });
    await tx.contractSigner.createMany({
      data: [
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0, createdAt: now, updatedAt: now },
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1, createdAt: now, updatedAt: now },
      ],
    });
  });
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  // amUserId : ACCOUNT_MANAGER (soumet). adminUserId : MSP_ADMIN (approuve).
  // On ajoute LEGAL_REVIEWER à sess-am : sans un rôle autorisé sur /approve,
  // la tentative RM-10 échouerait au portail des rôles (403) sans jamais
  // atteindre le domaine — le test ne prouverait alors rien sur RM-10.
  await sessions.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER', 'LEGAL_REVIEWER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await sessions.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  contractId = await prepare();
});

/**
 * Contrat « legacy » : passé directement en IN_REVIEW (comme le ferait une
 * ligne de données antérieure à l'introduction de contract_approvals), SANS
 * aucune ligne contract_approval. Reproduit l'état qu'aucun SUBMIT via l'API
 * ne peut plus produire aujourd'hui, mais que d'anciennes données peuvent
 * contenir.
 */
async function prepareLegacyInReview(): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-WFL-${id.slice(-8)}`,
        title: 'WF legacy', type: 'MAIN', status: 'IN_REVIEW', category: 'MAINTENANCE', currency: 'EUR',
        billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId, startDate: new Date('2026-08-01'),
        createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    });
    const v = await tx.contractVersion.create({
      data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id,
        versionNumber: 1, bodyHtml: '<p>Contenu</p>', variables: {}, createdAt: now, createdByUserId: fx.amUserId },
      select: { id: true },
    });
    await tx.contract.update({ where: { id }, data: { currentVersionId: v.id } });
    await tx.contractSigner.createMany({
      data: [
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'LSI', fullName: 'Marc', email: 'marc@lsi.fr', signingOrder: 0, createdAt: now, updatedAt: now },
        { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, party: 'CLIENT', fullName: 'Jean', email: 'jean@c.fr', signingOrder: 1, createdAt: now, updatedAt: now },
      ],
    });
    // Volontairement AUCUNE ligne contract_approval : c'est le cas legacy.
  });
  return id;
}

describe('workflow d’approbation', () => {
  test('soumission → IN_REVIEW + contract_approval PENDING', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/submit`).set('x-lsi-session', 'sess-am').expect(201);
    const approval = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractApproval.findFirst({ where: { contractId }, orderBy: { submittedAt: 'desc' } }));
    expect(approval!.decision).toBe('PENDING');
    expect(approval!.submittedByUserId).toBe(fx.amUserId);
  });

  test('RM-10 : le soumetteur ne peut pas approuver → 409', async () => {
    // sess-am est le soumetteur ; il tente d'approuver.
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/approve`).set('x-lsi-session', 'sess-am').expect(409);
  });

  test('un autre valideur approuve → APPROVED + contract_approval résolu', async () => {
    await request(app.getHttpServer()).post(`/v1/contracts/${contractId}/approve`).set('x-lsi-session', 'sess-admin').expect(201);
    const [c, approval] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: contractId }, select: { status: true } }),
      await tx.contractApproval.findFirst({ where: { contractId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    expect(c!.status).toBe('APPROVED');
    expect(approval!.decision).toBe('APPROVED');
    expect(approval!.decidedByUserId).toBe(fx.adminUserId);
  });

  test('fail-closed RM-10 : contrat legacy IN_REVIEW sans contract_approval → 409 (pas d’auto-approbation silencieuse)', async () => {
    const legacyId = await prepareLegacyInReview();

    await request(app.getHttpServer())
      .post(`/v1/contracts/${legacyId}/approve`)
      .set('x-lsi-session', 'sess-admin')
      .expect(409);

    const [c, approval] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: legacyId }, select: { status: true } }),
      await tx.contractApproval.findFirst({ where: { contractId: legacyId } }),
    ]);
    // Ni mutation de statut, ni écriture d'approbation : le throw précède tout.
    expect(c!.status).toBe('IN_REVIEW');
    expect(approval).toBeNull();
  });
});
