import { describe, test, expect, beforeAll } from 'vitest';
import { resolveUserScope } from '../../src/scope-resolution.js';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { uuidv7 } from '../../src/uuid.js';
import { PrismaClient } from '@prisma/client';

let fx: Fixture;
let owner: PrismaClient;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
});

/** Donne un rôle à un utilisateur (seed direct, propriétaire). */
async function grantRole(userId: string, code: string) {
  // roles a UNIQUE(tenant_id, code) : on réutilise le rôle s'il existe déjà.
  const existing = await owner.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM roles WHERE tenant_id = '${fx.tenantId}' AND code = '${code}'`,
  );
  const roleId = existing[0]?.id ?? uuidv7();
  if (!existing[0]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO roles (id, tenant_id, code, label)
      VALUES ('${roleId}', '${fx.tenantId}', '${code}', '${code}')
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO user_roles (tenant_id, user_id, role_id)
    VALUES ('${fx.tenantId}', '${userId}', '${roleId}')
    ON CONFLICT DO NOTHING
  `);
}

describe('resolveUserScope (§10.4)', () => {
  test('un account manager reçoit son portefeuille exact', async () => {
    await grantRole(fx.amUserId, 'ACCOUNT_MANAGER');
    const r = await resolveUserScope(fx.tenantId, fx.amUserId);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('INTERNAL');
    expect(r!.roles).toContain('ACCOUNT_MANAGER');
    expect(r!.scope.allCustomers).toBe(false);
    // customer_access ne contient que customerA pour cet AM (fixtures).
    expect(r!.scope.customerIds).toEqual([fx.customerA.id]);
  });

  test('un MSP_ADMIN reçoit allCustomers, sans portefeuille explicite', async () => {
    await grantRole(fx.adminUserId, 'MSP_ADMIN');
    const r = await resolveUserScope(fx.tenantId, fx.adminUserId);
    expect(r!.scope.allCustomers).toBe(true);
    expect(r!.scope.customerIds).toEqual([]);
    expect(r!.scope.actorKind).toBe('INTERNAL');
  });

  test('un utilisateur CLIENT est épinglé à son seul customer (RM-31)', async () => {
    const r = await resolveUserScope(fx.tenantId, fx.customerA.clientUserId);
    expect(r!.kind).toBe('CLIENT');
    expect(r!.scope.actorKind).toBe('CLIENT');
    expect(r!.scope.allCustomers).toBe(false);
    expect(r!.scope.customerIds).toEqual([fx.customerA.id]);
  });

  test('un utilisateur inexistant ne résout aucun scope', async () => {
    expect(await resolveUserScope(fx.tenantId, uuidv7())).toBeNull();
  });

  test('un utilisateur d’un AUTRE tenant ne résout rien', async () => {
    // Même id d'utilisateur, tenant différent → aucune fuite inter-tenant.
    expect(await resolveUserScope(uuidv7(), fx.amUserId)).toBeNull();
  });

  test('un compte DÉSACTIVÉ ne résout aucun scope (offboarding)', async () => {
    const disabled = uuidv7();
    await owner.$executeRawUnsafe(`
      INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
      VALUES ('${disabled}', '${fx.tenantId}', 'INTERNAL', NULL,
              'disabled-${disabled.slice(-12)}@lsi.fr', 'Parti', 'DISABLED', now(), now())
    `);
    expect(await resolveUserScope(fx.tenantId, disabled)).toBeNull();
  });

  test('un CLIENT ne peut jamais obtenir allCustomers, même avec un rôle admin injecté', async () => {
    // Défense : la fonction n'accorde all_customers qu'aux INTERNAL.
    // Un rôle MSP_ADMIN attribué par erreur à un CLIENT ne doit rien élargir.
    await grantRole(fx.customerB.clientUserId, 'MSP_ADMIN');
    const r = await resolveUserScope(fx.tenantId, fx.customerB.clientUserId);
    expect(r!.kind).toBe('CLIENT');
    expect(r!.scope.allCustomers).toBe(false);
    expect(r!.scope.customerIds).toEqual([fx.customerB.id]);
  });
});
