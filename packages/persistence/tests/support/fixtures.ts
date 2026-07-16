import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/uuid.js';

export interface CustomerFixture {
  id: string;
  name: string;
  contractId: string;
}

export interface Fixture {
  tenantId: string;
  customerA: CustomerFixture;
  customerB: CustomerFixture;
}

/**
 * Applique les migrations en tant que PROPRIÉTAIRE (lsi_owner),
 * jamais en tant que rôle applicatif.
 */
export async function applyMigrations(): Promise<void> {
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  });
}

/**
 * Deux clients, un contrat chacun.
 *
 * Le seed s'exécute avec le rôle propriétaire et RLS désactivée pour lui :
 * on prépare l'état, on ne teste pas le seed. Tous les tests d'isolation
 * lisent ensuite via le rôle applicatif `lsi_app`.
 */
export async function seedTwoCustomers(): Promise<Fixture> {
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  const tenantId = uuidv7();
  const a: CustomerFixture = { id: uuidv7(), name: 'Dupont SAS', contractId: uuidv7() };
  const b: CustomerFixture = { id: uuidv7(), name: 'Martin SARL', contractId: uuidv7() };

  // Slug dérivé de la QUEUE de l'uuid, pas de sa tête.
  // Dans un UUIDv7 les premiers caractères hex sont les bits de poids fort de
  // l'horodatage ms : ils sont IDENTIQUES pour tout ce qui est généré dans la
  // même fenêtre de ~65 s. slice(0, 8) collisionne donc systématiquement.
  // Les 12 derniers caractères sont aléatoires.
  await owner.$executeRawUnsafe(`
    INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
    VALUES ('${tenantId}', 'LSI Maintenance', 'lsi-${tenantId.slice(-12)}', 'ACTIVE', now(), now())
  `);

  for (const c of [a, b]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO customers (id, tenant_id, name, status, created_at, updated_at)
      VALUES ('${c.id}', '${tenantId}', '${c.name}', 'ACTIVE', now(), now())
    `);
    // La référence est unique PAR TENANT ; chaque seed crée son propre tenant,
    // mais on garde la dérivation pour rester robuste si cela change.
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status,
                             created_at, updated_at)
      VALUES ('${c.contractId}', '${tenantId}', '${c.id}',
              'LSI-2026-${c.contractId.slice(-12)}',
              'Contrat ${c.name}', 'MAIN', 'DRAFT', now(), now())
    `);
  }

  await owner.$disconnect();
  return { tenantId, customerA: a, customerB: b };
}
