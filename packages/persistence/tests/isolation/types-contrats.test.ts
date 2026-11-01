import { describe, test, expect, beforeAll } from 'vitest';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { withScope, adminScope, clientScope } from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';
import { createPrismaClient } from '../../src/prisma-client.js';

/**
 * Garanties de la migration 34 (types de contrats, grilles par durée) —
 * testées EN BASE, sous le rôle applicatif lsi_app : codes calculés par la
 * base, uniques et jamais réattribués, préfixe figé dès le premier code, type
 * prédéfini indestructible, prix append-only.
 */
let fx: Fixture;
let other: Fixture;

beforeAll(async () => {
  await applyMigrations();
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers();
});

const admin = (f: Fixture = fx) => adminScope(f.tenantId, f.adminUserId);

async function createKind(f: Fixture, p: { prefix: string; systemKey?: string }) {
  const now = new Date();
  return withScope(admin(f), (tx) =>
    tx.contractKind.create({
      data: {
        id: uuidv7(), tenantId: f.tenantId, prefix: p.prefix, label: `Type ${p.prefix}`,
        systemKey: p.systemKey ?? null, isSystem: p.systemKey !== undefined, createdAt: now, updatedAt: now,
      },
    }),
  );
}

async function createTerm(f: Fixture, months: number) {
  const now = new Date();
  return withScope(admin(f), (tx) =>
    tx.commitmentTerm.create({ data: { id: uuidv7(), tenantId: f.tenantId, months, label: `${months} mois`, createdAt: now, updatedAt: now } }),
  );
}

async function createItem(f: Fixture, kindId: string, label = 'Licence') {
  const now = new Date();
  return withScope(admin(f), (tx) =>
    tx.priceGridItem.create({
      data: {
        id: uuidv7(), tenantId: f.tenantId, contractKindId: kindId, number: 0, code: 'IGNORE',
        label, unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20', createdAt: now, updatedAt: now,
      },
    }),
  );
}

async function createVariant(f: Fixture, itemId: string, termId: string) {
  const now = new Date();
  return withScope(admin(f), (tx) =>
    tx.priceGridVariant.create({
      data: { id: uuidv7(), tenantId: f.tenantId, itemId, commitmentTermId: termId, code: 'IGNORE', createdAt: now, updatedAt: now },
    }),
  );
}

describe('types de contrats — préfixe', () => {
  test('préfixe : format imposé par la base (2 à 6 caractères, majuscules et chiffres)', async () => {
    for (const bad of ['M', 'm365', 'TROPLONG', 'M-3']) {
      await expect(createKind(fx, { prefix: bad })).rejects.toThrow(/check|contract_kinds_prefix/i);
    }
  });

  test('préfixe unique par tenant, réutilisable dans un autre tenant', async () => {
    await createKind(fx, { prefix: 'UNIQ' });
    await expect(createKind(fx, { prefix: 'UNIQ' })).rejects.toThrow(/Unique constraint|contract_kinds_prefix_key/i);
    await expect(createKind(other, { prefix: 'UNIQ' })).resolves.toBeTruthy();
  });

  test('préfixe modifiable tant qu\'aucun code ne l\'utilise, figé ensuite', async () => {
    const k = await createKind(fx, { prefix: 'AVANT' });
    await withScope(admin(), (tx) => tx.contractKind.update({ where: { id: k.id }, data: { prefix: 'APRES' } }));
    await createItem(fx, k.id);
    await expect(withScope(admin(), (tx) => tx.contractKind.update({ where: { id: k.id }, data: { prefix: 'AUTRE' } })))
      .rejects.toThrow(/préfixe utilisé/);
  });

  test('type prédéfini : suppression interdite ; type personnalisé sans code : supprimable', async () => {
    const sys = await createKind(fx, { prefix: 'SYS', systemKey: 'SYS_TEST' });
    await expect(withScope(admin(), (tx) => tx.contractKind.delete({ where: { id: sys.id } }))).rejects.toThrow(/prédéfini/);
    await expect(withScope(admin(), (tx) => tx.contractKind.update({ where: { id: sys.id }, data: { isSystem: false, systemKey: null } })))
      .rejects.toThrow(/prédéfini non modifiable/);
    const perso = await createKind(fx, { prefix: 'PERSO' });
    await withScope(admin(), (tx) => tx.contractKind.delete({ where: { id: perso.id } }));
  });

  test('type avec codes : suppression refusée (clé étrangère)', async () => {
    const k = await createKind(fx, { prefix: 'GARDE' });
    await createItem(fx, k.id);
    await expect(withScope(admin(), (tx) => tx.contractKind.delete({ where: { id: k.id } }))).rejects.toThrow(/foreign key|price_grid_items_kind_fk/i);
  });
});

describe('codes tarifs', () => {
  test('codes de base {PREFIXE}-{NNNN} séquentiels par type, valeurs fournies ignorées', async () => {
    const a = await createKind(fx, { prefix: 'SEQA' });
    const b = await createKind(fx, { prefix: 'SEQB' });
    const a1 = await createItem(fx, a.id);
    const a2 = await createItem(fx, a.id);
    const b1 = await createItem(fx, b.id);
    expect([a1.code, a2.code, b1.code]).toEqual(['SEQA-0001', 'SEQA-0002', 'SEQB-0001']);
    expect([a1.number, a2.number]).toEqual([1, 2]);
  });

  test('créations concurrentes : numéros distincts, sans trou', async () => {
    const k = await createKind(fx, { prefix: 'CONC' });
    const items = await Promise.all(Array.from({ length: 8 }, () => createItem(fx, k.id)));
    expect(items.map((i) => i.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('jamais réattribués : DELETE révoqué, compteur qui ne recule pas, code figé', async () => {
    const k = await createKind(fx, { prefix: 'FIXE' });
    const i = await createItem(fx, k.id);
    await expect(withScope(admin(), (tx) => tx.priceGridItem.delete({ where: { id: i.id } }))).rejects.toThrow(/permission denied/i);
    await expect(withScope(admin(), (tx) => tx.priceGridItem.update({ where: { id: i.id }, data: { code: 'FIXE-0099' } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withScope(admin(), (tx) => tx.contractKind.update({ where: { id: k.id }, data: { lastItemNumber: 0 } })))
      .rejects.toThrow(/ne recule pas/);
    // Archivé puis nouveau code : le numéro suivant, jamais l'ancien.
    await withScope(admin(), (tx) => tx.priceGridItem.update({ where: { id: i.id }, data: { archivedAt: new Date() } }));
    expect((await createItem(fx, k.id)).code).toBe('FIXE-0002');
  });

  test('versions {PREFIXE}-{NNNN}-E{DD}, une seule par durée', async () => {
    const k = await createKind(fx, { prefix: 'VERS' });
    const t0 = await createTerm(fx, 0);
    const t12 = await createTerm(fx, 12);
    const i = await createItem(fx, k.id);
    const v0 = await createVariant(fx, i.id, t0.id);
    const v12 = await createVariant(fx, i.id, t12.id);
    expect([v0.code, v12.code]).toEqual(['VERS-0001-E00', 'VERS-0001-E12']);
    await expect(createVariant(fx, i.id, t12.id)).rejects.toThrow(/Unique constraint|price_grid_variants_term_key/i);
    await expect(withScope(admin(), (tx) => tx.commitmentTerm.update({ where: { id: t12.id }, data: { months: 18 } })))
      .rejects.toThrow(/permission denied/i);
  });

  test('durée hors 0–99 refusée ; une durée par nombre de mois et par tenant', async () => {
    await expect(createTerm(other, 100)).rejects.toThrow(/check/i);
    await createTerm(other, 24);
    await expect(createTerm(other, 24)).rejects.toThrow(/Unique constraint|commitment_terms_months_key/i);
  });

  test('prix append-only', async () => {
    const k = await createKind(other, { prefix: 'PRIX' });
    const t = await createTerm(other, 36);
    const i = await createItem(other, k.id);
    const v = await createVariant(other, i.id, t.id);
    const p = await withScope(admin(other), (tx) =>
      tx.priceGridPrice.create({
        data: { id: uuidv7(), tenantId: other.tenantId, variantId: v.id, effectiveFrom: new Date('2026-01-01'), unitPrice: '12.5', createdAt: new Date() },
      }),
    );
    await expect(withScope(admin(other), (tx) => tx.priceGridPrice.update({ where: { id: p.id }, data: { unitPrice: '1' } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withScope(admin(other), (tx) => tx.priceGridPrice.delete({ where: { id: p.id } }))).rejects.toThrow(/permission denied/i);
  });
});

describe('isolation', () => {
  test('un autre tenant ne voit pas les types ; un client du portail non plus', async () => {
    await createKind(fx, { prefix: 'ISOL' });
    const seenByOther = await withScope(admin(other), (tx) => tx.contractKind.findMany({ where: { prefix: 'ISOL' } }));
    expect(seenByOther).toEqual([]);
    const seenByClient = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.contractKind.findMany(),
    );
    expect(seenByClient).toEqual([]);
  });
});

describe('retour arrière de la migration 34', () => {
  test('montée → descente → montée sur une base dédiée', async () => {
    const { execSync } = await import('node:child_process');
    const owner = createPrismaClient(process.env.DATABASE_URL);
    const db = `rollback_${Date.now()}`;
    await owner.$executeRawUnsafe(`CREATE DATABASE ${db}`);
    await owner.$disconnect();
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    const env = { ...process.env, DATABASE_URL: url.toString() };
    const run = (cmd: string) => execSync(cmd, { env, stdio: 'pipe' });
    run('pnpm exec prisma migrate deploy');
    run(`pnpm exec prisma db execute --file prisma/rollback/00000000000034_types_contrats.down.sql`);
    const probe = createPrismaClient(url.toString());
    const [first] = await probe.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name IN ('contract_kinds', 'price_grid_items')`,
    );
    expect(Number(first!.n)).toBe(0);
    await probe.$disconnect();
    run('pnpm exec prisma migrate deploy');
    const again = createPrismaClient(url.toString());
    const [second] = await again.$queryRawUnsafe<{ m: bigint }[]>(
      `SELECT count(*) AS m FROM information_schema.tables WHERE table_name IN ('contract_kinds', 'price_grid_items')`,
    );
    expect(Number(second!.m)).toBe(2);
    await again.$disconnect();
  }, 120_000);
});
