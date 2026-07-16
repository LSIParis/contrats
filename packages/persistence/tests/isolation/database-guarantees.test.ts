import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../support/fixtures.js';

let owner: PrismaClient;

/** Tables hors périmètre de cloisonnement, chacune justifiée. */
const EXEMPTES = new Set([
  '_prisma_migrations', // outillage
  'tenants', // classe « plateforme » : politique propre, testée à part
]);

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
});

/**
 * Les tests structurels. (§16.4-A, R14)
 *
 * Ils valent plus que tous les autres réunis : ils rendent le cloisonnement
 * impossible à OUBLIER. Une table ajoutée sans RLS casse la CI le jour même,
 * pas six mois plus tard en production.
 *
 * Aucune revue humaine ne tient cette promesse sur trois ans.
 */
describe('garanties structurelles de la base', () => {
  test('toute table métier a RLS activée ET forcée ET au moins une politique', async () => {
    const rows = await owner.$queryRawUnsafe<
      { relname: string; rls: boolean; force: boolean; policies: bigint }[]
    >(`
      SELECT c.relname,
             c.relrowsecurity      AS rls,
             c.relforcerowsecurity AS force,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);

    const metier = rows.filter((r) => !EXEMPTES.has(r.relname));
    expect(metier.length, 'aucune table trouvée — le test se croirait vert à tort').toBeGreaterThan(
      0,
    );

    for (const t of metier) {
      expect(t.rls, `${t.relname} : ROW LEVEL SECURITY désactivée`).toBe(true);
      expect(t.force, `${t.relname} : FORCE ROW LEVEL SECURITY manquant`).toBe(true);
      expect(Number(t.policies), `${t.relname} : aucune politique`).toBeGreaterThan(0);
    }
  });

  test('toute table métier porte tenant_id', async () => {
    // RM-28. `customers` porte le scope via sa propre colonne id.
    const rows = await owner.$queryRawUnsafe<{ relname: string }[]>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname NOT IN ('_prisma_migrations', 'tenants')
        AND NOT EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
        )
    `);
    expect(rows.map((r) => r.relname), 'tables sans tenant_id').toEqual([]);
  });

  test('lsi_app n’a NI BYPASSRLS NI superuser', async () => {
    const [r] = await owner.$queryRawUnsafe<{ bypass: boolean; superuser: boolean }[]>(`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser
      FROM pg_roles WHERE rolname = 'lsi_app'
    `);
    expect(r, 'le rôle lsi_app n’existe pas').toBeDefined();
    expect(r!.bypass, 'lsi_app peut contourner RLS').toBe(false);
    expect(r!.superuser, 'lsi_app est superuser').toBe(false);
  });

  test('lsi_app n’est propriétaire d’aucune table métier', async () => {
    // Un propriétaire contourne RLS par défaut. FORCE couvre le cas, mais
    // la ceinture ET les bretelles : il n'a aucune raison d'être propriétaire.
    const rows = await owner.$queryRawUnsafe<{ relname: string }[]>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = 'lsi_app'
    `);
    expect(rows.map((r) => r.relname), 'tables possédées par lsi_app').toEqual([]);
  });
});

describe('intégrité référentielle composite (§8.4)', () => {
  test('un commentaire ne peut pas être rattaché au contrat d’un autre client', async () => {
    // Sans FK composite, RLS ne verrait rien à redire : elle vérifie le scope
    // de la ligne, pas sa COHÉRENCE. La ligne serait visible du client A tout
    // en parlant du contrat de B.
    const { seedTwoCustomers } = await import('../support/fixtures.js');
    const { uuidv7 } = await import('../../src/uuid.js');
    const fx = await seedTwoCustomers();

    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO comments (id, tenant_id, customer_id, contract_id, visibility, body, created_at)
        VALUES ('${uuidv7()}', '${fx.tenantId}', '${fx.customerA.id}',
                '${fx.customerB.contractId}', 'INTERNAL', 'incohérent', now())
      `),
    ).rejects.toThrow(/foreign key constraint/i);
  });
});
