import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/uuid.js';

export interface CustomerFixture {
  id: string;
  name: string;
  contractId: string;
  /** Utilisateur CLIENT rattaché à ce customer (RM-31). */
  clientUserId: string;
}

export interface Fixture {
  tenantId: string;
  /** ACCOUNT_MANAGER, portefeuille = customerA uniquement. */
  amUserId: string;
  /** MSP_ADMIN, accès all_customers. */
  adminUserId: string;
  customerA: CustomerFixture;
  customerB: CustomerFixture;
}

let migrated = false;

/** Applique les migrations en tant que PROPRIÉTAIRE, jamais en tant que lsi_app. */
export async function applyMigrations(): Promise<void> {
  if (migrated) return;
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  });
  migrated = true;
}

/**
 * Deux clients, un contrat chacun, plus les utilisateurs qui vont avec.
 *
 * Le seed s'exécute avec le rôle propriétaire : on prépare l'état, on ne teste
 * pas le seed. Tous les tests d'isolation lisent ensuite via `lsi_app`.
 *
 * Note : les identifiants dérivés utilisent slice(-12), la QUEUE de l'uuid.
 * Dans un UUIDv7 les premiers caractères hex sont l'horodatage ms : ils sont
 * identiques pour tout ce qui naît dans la même fenêtre de ~65 s.
 */
export async function seedTwoCustomers(): Promise<Fixture> {
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const now = 'now()';

  const tenantId = uuidv7();
  const amUserId = uuidv7();
  const adminUserId = uuidv7();
  const a: CustomerFixture = {
    id: uuidv7(),
    name: 'Dupont SAS',
    contractId: uuidv7(),
    clientUserId: uuidv7(),
  };
  const b: CustomerFixture = {
    id: uuidv7(),
    name: 'Martin SARL',
    contractId: uuidv7(),
    clientUserId: uuidv7(),
  };

  await owner.$executeRawUnsafe(`
    INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
    VALUES ('${tenantId}', 'LSI Maintenance', 'lsi-${tenantId.slice(-12)}', 'ACTIVE', ${now}, ${now})
  `);

  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO customers (id, tenant_id, name, country, status, created_at, updated_at)
      VALUES ('${c.id}', '${tenantId}', '${c.name}', 'FR', 'ACTIVE', ${now}, ${now})
    `);
  }

  // Utilisateurs INTERNAL : customer_id NULL (RM-32, CHECK en base).
  await owner.$executeRawUnsafe(`
    INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
    VALUES
      ('${amUserId}',    '${tenantId}', 'INTERNAL', NULL, 'am-${amUserId.slice(-12)}@lsi.fr',    'Sylvie M.', 'ACTIVE', ${now}, ${now}),
      ('${adminUserId}', '${tenantId}', 'INTERNAL', NULL, 'adm-${adminUserId.slice(-12)}@lsi.fr', 'Marc D.',  'ACTIVE', ${now}, ${now})
  `);

  // Utilisateurs CLIENT : customer_id obligatoire, épinglé (RM-31).
  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
      VALUES ('${c.clientUserId}', '${tenantId}', 'CLIENT', '${c.id}',
              'client-${c.clientUserId.slice(-12)}@example.fr', 'Contact ${c.name}', 'ACTIVE', ${now}, ${now})
    `);
  }

  // Le portefeuille de l'account manager : customerA SEULEMENT.
  await owner.$executeRawUnsafe(`
    INSERT INTO customer_access (tenant_id, user_id, customer_id, granted_by_user_id, granted_at)
    VALUES ('${tenantId}', '${amUserId}', '${a.id}', '${adminUserId}', ${now})
  `);

  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
                             currency, billing_frequency, owner_user_id,
                             created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${c.contractId}', '${tenantId}', '${c.id}',
              'LSI-2026-${c.contractId.slice(-12)}', 'Contrat ${c.name}', 'MAIN', 'DRAFT', 'MAINTENANCE',
              'EUR', 'MONTHLY', '${amUserId}', ${now}, ${now}, '${amUserId}', '${amUserId}')
    `);
  }

  await owner.$disconnect();
  return { tenantId, amUserId, adminUserId, customerA: a, customerB: b };
}
