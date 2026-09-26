import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { withScope, adminScope, clientScope } from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';

/** Garanties des migrations 18-19 (cycle de vie v2), sous le rôle lsi_app. */
let owner: PrismaClient;
let fx: Fixture;
let versionA: string;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  versionA = uuidv7();
  await owner.$executeRawUnsafe(`INSERT INTO contract_versions (id, tenant_id, customer_id, contract_id, version_number,
      body_html, variables, created_at, created_by_user_id)
    VALUES ('${versionA}', '${fx.tenantId}', '${fx.customerA.id}', '${fx.customerA.contractId}', 1, '<p>v1</p>', '{}', now(), '${fx.amUserId}')`);
});

describe('backfill des périodes initiales (app_backfill_initial_periods)', () => {
  test('crée une période INITIALE pour chaque contrat daté qui n’en a pas, et est idempotent', async () => {
    await owner.$executeRawUnsafe(`UPDATE contracts SET start_date='2026-01-01', end_date='2026-12-31'
      WHERE id IN ('${fx.customerA.contractId}', '${fx.customerB.contractId}')`);
    const first = await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT app_backfill_initial_periods() AS n`);
    expect(first[0]!.n).toBeGreaterThanOrEqual(2);
    const again = await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT app_backfill_initial_periods() AS n`);
    expect(again[0]!.n).toBe(0);
    const periods = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractPeriod.findMany({ where: { contractId: fx.customerA.contractId } }),
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ periodNumber: 1, kind: 'INITIAL' });
  });

  test('un contrat sans dates n’est pas touché', async () => {
    const id = uuidv7();
    await owner.$executeRawUnsafe(`INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
      currency, billing_frequency, owner_user_id, created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${id}', '${fx.tenantId}', '${fx.customerA.id}', 'ND-${id.slice(-12)}', 'Sans dates', 'MAIN', 'DRAFT',
      'MAINTENANCE', 'EUR', 'MONTHLY', '${fx.amUserId}', now(), now(), '${fx.amUserId}', '${fx.amUserId}')`);
    await owner.$queryRawUnsafe(`SELECT app_backfill_initial_periods()`);
    const n = await owner.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM contract_periods WHERE contract_id='${id}'`);
    expect(Number(n[0]!.n)).toBe(0);
  });
});

describe('contract_acceptances', () => {
  test('le client accepte une version de SON contrat ; la trace est immuable', async () => {
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const id = uuidv7();
    await withScope(client, (tx) =>
      tx.contractAcceptance.create({
        data: {
          id, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
          versionId: versionA, method: 'PORTAL', acceptedByUserId: fx.customerA.clientUserId,
          acceptedByName: 'Contact Dupont', acceptedByEmail: 'contact@dupont.fr', ip: '203.0.113.7',
          acceptedAt: new Date(),
        },
      }),
    );
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractAcceptance.update({ where: { id }, data: { acceptedByName: 'réécrit' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('le client B ne voit pas l’acceptation du client A', async () => {
    const rows = await withScope(clientScope(fx.tenantId, fx.customerB.id, fx.customerB.clientUserId), (tx) =>
      tx.contractAcceptance.findMany({ where: { contractId: fx.customerA.contractId } }),
    );
    expect(rows).toEqual([]);
  });

  test('une acceptation saisie par LSI exige une pièce justificative (CHECK)', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractAcceptance.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
            versionId: versionA, method: 'RECORDED_BY_STAFF', acceptedByName: 'X', acceptedByEmail: 'x@y.fr',
            acceptedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  test('cohérence : une acceptation ne peut pas viser la version d’un autre client', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractAcceptance.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerB.id, contractId: fx.customerB.contractId,
            versionId: versionA, method: 'PORTAL', acceptedByName: 'X', acceptedByEmail: 'x@y.fr', acceptedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('contracts : contraintes v2', () => {
  test('préavis en jours ET en mois refusé', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contract.update({ where: { id: fx.customerA.contractId }, data: { noticePeriodDays: 30, noticePeriodMonths: 1 } }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  test('reconduction sans durée de reconduction refusée', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contract.update({ where: { id: fx.customerA.contractId }, data: { renewalMode: 'TACIT' } }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  test('un client ne peut pas créer de période contractuelle', async () => {
    await expect(
      withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
        tx.contractPeriod.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
            periodNumber: 9, kind: 'TACIT_RENEWAL', startDate: new Date('2027-01-01'), endDate: new Date('2027-12-31'),
            createdAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
