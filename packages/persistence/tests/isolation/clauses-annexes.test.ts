import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { withScope, adminScope, clientScope, internalScope } from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';

/** Garanties de la migration 22 (clauses, modèles structurés, annexes), sous lsi_app. */
let owner: PrismaClient;
let fx: Fixture;
let other: Fixture;
let clauseVersionId: string;
let contractClauseId: string;
let versionA: string;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers();
  const admin = adminScope(fx.tenantId, fx.adminUserId);
  const itemId = uuidv7();
  clauseVersionId = uuidv7();
  versionA = uuidv7();
  contractClauseId = uuidv7();
  await withScope(admin, async (tx) => {
    await tx.clauseLibraryItem.create({ data: { id: itemId, tenantId: fx.tenantId, code: `OBJ-${itemId.slice(-6).toUpperCase()}`, category: 'OBJET', title: 'Objet', createdAt: new Date(), updatedAt: new Date() } });
    await tx.clauseLibraryItemVersion.create({ data: { id: clauseVersionId, tenantId: fx.tenantId, itemId, versionNumber: 1, bodyHtml: '<p>v1</p>', createdAt: new Date() } });
    await tx.contractVersion.create({ data: { id: versionA, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: new Date(), createdByUserId: fx.amUserId } });
    await tx.contractClause.create({ data: { id: contractClauseId, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId, versionId: versionA, position: 1, clauseKey: 'OBJET', category: 'OBJET', title: 'Objet', bodyHtml: '<p>x</p>', origin: 'TEMPLATE' } });
  });
});

describe('immuabilité', () => {
  test('une version de clause de bibliothèque ne se réécrit pas', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.clauseLibraryItemVersion.update({ where: { id: clauseVersionId }, data: { bodyHtml: '<p>réécrit</p>' } })),
    ).rejects.toThrow(/permission denied/i);
  });

  test('les clauses d’une version de contrat sont figées avec elle', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractClause.update({ where: { id: contractClauseId }, data: { bodyHtml: '<p>réécrit</p>' } })),
    ).rejects.toThrow(/permission denied/i);
  });

  test('une revue de clause ne se réécrit ni ne s’efface', async () => {
    const id = uuidv7();
    const admin = adminScope(fx.tenantId, fx.adminUserId);
    await withScope(admin, (tx) => tx.contractClauseReview.create({ data: {
      id, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId, clauseId: contractClauseId,
      decision: 'APPROVED', reviewedByUserId: fx.adminUserId, reviewedAt: new Date(),
    } }));
    await expect(withScope(admin, (tx) => tx.contractClauseReview.update({ where: { id }, data: { decision: 'REJECTED' } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withScope(admin, (tx) => tx.contractClauseReview.delete({ where: { id } }))).rejects.toThrow(/permission denied/i);
  });
});

describe('cloisonnement', () => {
  test('la bibliothèque d’un tenant est invisible d’un autre tenant', async () => {
    const rows = await withScope(adminScope(other.tenantId, other.adminUserId), (tx) =>
      tx.clauseLibraryItemVersion.findMany({ where: { id: clauseVersionId } }));
    expect(rows).toEqual([]);
  });

  test('un client ne lit pas la bibliothèque de clauses', async () => {
    const rows = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.clauseLibraryItem.findMany());
    expect(rows).toEqual([]);
  });

  test('les clauses du contrat A sont invisibles du commercial de B, et une annexe ne peut viser la version d’un autre client', async () => {
    const rows = await withScope(internalScope(fx.tenantId, [fx.customerB.id], fx.amUserId), (tx) =>
      tx.contractClause.findMany({ where: { contractId: fx.customerA.contractId } }));
    expect(rows).toEqual([]);
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.annex.create({ data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerB.id, contractId: fx.customerB.contractId,
        versionId: versionA, position: 1, kind: 'SLA', title: 'x', bodyHtml: '<p>x</p>',
      } })),
    ).rejects.toThrow(/foreign key/i);
  });

  test('un client ne peut pas écrire de clause, même sur son contrat', async () => {
    await expect(
      withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) => tx.contractClause.create({ data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId, versionId: versionA,
        position: 9, clauseKey: 'X', category: 'DIVERS', title: 'x', bodyHtml: 'x', origin: 'CUSTOM',
      } })),
    ).rejects.toThrow(/row-level security/i);
  });
});
