/**
 * Seed de DÉMO (opérateur, optionnel) : insère un customer + 2 contrats dans
 * une instance Contrat vide, pour tester l'import côté ticketing.
 *
 * Écrit avec le rôle propriétaire (comme packages/persistence/src/testing/seed.ts).
 * Idempotent sur le customer/contrats via un slug de tenant fixe et ON CONFLICT.
 * À lancer une fois, manuellement, contre la base cible (DATABASE_URL).
 *
 *   pnpm --filter @lsi/api exec tsx apps/api/scripts/seed-demo-contracts.ts
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7, findTenantBySlug } from '@lsi/persistence';

async function main() {
  const slug = process.env.DEFAULT_TENANT_SLUG ?? 'lsi';
  const tenantId = await findTenantBySlug(slug);
  if (!tenantId) throw new Error(`Tenant introuvable pour le slug "${slug}"`);

  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const customerId = uuidv7();
  const ownerUserId = (
    await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM users WHERE tenant_id='${tenantId}' AND kind='INTERNAL' LIMIT 1`,
    )
  )[0]?.id;
  if (!ownerUserId) throw new Error('Aucun utilisateur INTERNAL pour porter les contrats de démo');

  await owner.$executeRawUnsafe(`
    INSERT INTO customers (id, tenant_id, name, country, status, created_at, updated_at)
    VALUES ('${customerId}', '${tenantId}', 'Client Démo Ticketing', 'FR', 'ACTIVE', now(), now())
  `);

  for (const [ref, title, status] of [
    ['DEMO-2026-001', 'Contrat maintenance Démo', 'ACTIVE'],
    ['DEMO-2026-002', 'Contrat support Démo', 'SIGNED'],
  ] as const) {
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
                             currency, billing_frequency, owner_user_id,
                             created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${uuidv7()}', '${tenantId}', '${customerId}', '${ref}', '${title}', 'MAIN', '${status}',
              'MAINTENANCE', 'EUR', 'MONTHLY', '${ownerUserId}', now(), now(), '${ownerUserId}', '${ownerUserId}')
    `);
  }
  await owner.$disconnect();
  console.log(`Seed démo OK: customer ${customerId} + 2 contrats sous tenant ${tenantId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
