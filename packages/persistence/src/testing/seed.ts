/**
 * Utilitaires de SEED, réservés aux tests.
 *
 * Ils vivent dans @lsi/persistence — le seul module autorisé à importer
 * Prisma (§16.4-D) — et sont exposés via l'entrée `@lsi/persistence/testing`.
 *
 * Pourquoi pas directement dans apps/api/tests ? Parce qu'il aurait fallu y
 * autoriser l'import de @prisma/client, donc percer la frontière pour tout
 * ce répertoire. Une exception d'ESLint est une dette : mieux vaut un point
 * d'entrée nommé qu'un trou dans la règle.
 *
 * Ces helpers écrivent avec le rôle PROPRIÉTAIRE : ils préparent l'état,
 * ils ne sont pas sous test. Le code applicatif, lui, passe par lsi_app.
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../uuid.js';

export interface CustomerFixture {
  id: string;
  name: string;
  contractId: string;
  clientUserId: string;
  /** Email du contact client (kind CLIENT). */
  clientEmail: string;
}

export interface TwoCustomerFixture {
  tenantId: string;
  /** Slug du tenant seedé (pour DEFAULT_TENANT_SLUG). */
  tenantSlug: string;
  /** ACCOUNT_MANAGER, portefeuille = customerA uniquement. */
  amUserId: string;
  amEmail: string;
  /** ACCOUNT_MANAGER, portefeuille = customerB uniquement. */
  amBUserId: string;
  /** MSP_ADMIN, accès all_customers. */
  adminUserId: string;
  customerA: CustomerFixture;
  customerB: CustomerFixture;
}

/**
 * Deux clients aux portefeuilles DISJOINTS.
 *
 * C'est la disjonction qui rend les tests d'isolation significatifs : si les
 * deux account managers voyaient les deux clients, le test IDOR passerait
 * sans rien prouver.
 *
 * Note : les identifiants dérivés utilisent slice(-12), la QUEUE de l'uuid.
 * Dans un UUIDv7 les premiers caractères hex sont l'horodatage ms — ils sont
 * identiques pour tout ce qui naît dans la même fenêtre de ~65 s.
 */
export async function seedTwoCustomers(databaseUrl?: string): Promise<TwoCustomerFixture> {
  const owner = new PrismaClient({ datasourceUrl: databaseUrl ?? process.env.DATABASE_URL });

  const tenantId = uuidv7();
  const amUserId = uuidv7();
  const amBUserId = uuidv7();
  const adminUserId = uuidv7();
  const aClientUser = uuidv7();
  const bClientUser = uuidv7();
  const a: CustomerFixture = {
    id: uuidv7(),
    name: 'Dupont SAS',
    contractId: uuidv7(),
    clientUserId: aClientUser,
    clientEmail: `cl-${aClientUser.slice(-12)}@example.fr`,
  };
  const b: CustomerFixture = {
    id: uuidv7(),
    name: 'Martin SARL',
    contractId: uuidv7(),
    clientUserId: bClientUser,
    clientEmail: `cl-${bClientUser.slice(-12)}@example.fr`,
  };

  await owner.$executeRawUnsafe(`
    INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
    VALUES ('${tenantId}', 'LSI Maintenance', 'lsi-${tenantId.slice(-12)}', 'ACTIVE', now(), now())
  `);

  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO customers (id, tenant_id, name, country, status, created_at, updated_at)
      VALUES ('${c.id}', '${tenantId}', '${c.name}', 'FR', 'ACTIVE', now(), now())
    `);
  }

  // INTERNAL → customer_id NULL (RM-32, CHECK en base).
  await owner.$executeRawUnsafe(`
    INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
    VALUES
      ('${amUserId}',    '${tenantId}', 'INTERNAL', NULL, 'am-a-${amUserId.slice(-12)}@lsi.fr',   'Sylvie M.', 'ACTIVE', now(), now()),
      ('${amBUserId}',   '${tenantId}', 'INTERNAL', NULL, 'am-b-${amBUserId.slice(-12)}@lsi.fr',  'Julie R.',  'ACTIVE', now(), now()),
      ('${adminUserId}', '${tenantId}', 'INTERNAL', NULL, 'adm-${adminUserId.slice(-12)}@lsi.fr', 'Marc D.',   'ACTIVE', now(), now())
  `);

  // CLIENT → customer_id obligatoire, épinglé (RM-31).
  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
      VALUES ('${c.clientUserId}', '${tenantId}', 'CLIENT', '${c.id}',
              '${c.clientEmail}', 'Contact ${c.name}', 'ACTIVE', now(), now())
    `);
  }

  await owner.$executeRawUnsafe(`
    INSERT INTO customer_access (tenant_id, user_id, customer_id, granted_by_user_id, granted_at)
    VALUES ('${tenantId}', '${amUserId}',  '${a.id}', '${adminUserId}', now()),
           ('${tenantId}', '${amBUserId}', '${b.id}', '${adminUserId}', now())
  `);

  for (const [c, ownerId] of [
    [a, amUserId],
    [b, amBUserId],
  ] as const) {
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
                             currency, billing_frequency, owner_user_id,
                             created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${c.contractId}', '${tenantId}', '${c.id}',
              'LSI-2025-${c.contractId.slice(-12)}', 'Contrat ${c.name}', 'MAIN', 'DRAFT', 'MAINTENANCE',
              'EUR', 'MONTHLY', '${ownerId}', now(), now(), '${ownerId}', '${ownerId}')
    `);
  }

  await owner.$disconnect();
  return {
    tenantId,
    tenantSlug: `lsi-${tenantId.slice(-12)}`,
    amUserId,
    amEmail: `am-a-${amUserId.slice(-12)}@lsi.fr`,
    amBUserId,
    adminUserId,
    customerA: a,
    customerB: b,
  };
}
