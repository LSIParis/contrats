import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { withScope, internalScope, adminScope, clientScope } from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';

/**
 * Garanties de la migration 21 (tarification) — testées EN BASE, sous le
 * rôle applicatif lsi_app. Le service applicatif respecte ces règles ; ces
 * tests prouvent que la base les impose MÊME si un service les oubliait.
 */
let owner: PrismaClient;
let fx: Fixture;
let other: Fixture; // second tenant

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers();
});

const admin = () => adminScope(fx.tenantId, fx.adminUserId);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function createSchedule(
  f: Fixture,
  which: 'customerA' | 'customerB',
  p: { version: number; from: string; to?: string | null; status?: 'DRAFT' | 'ACTIVE' },
) {
  const c = f[which];
  const id = uuidv7();
  const status = p.status ?? 'DRAFT';
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), async (tx) => {
    // Les lignes s'écrivent sur un BROUILLON (trigger), puis on active.
    await tx.pricingSchedule.create({
      data: {
        id, tenantId: f.tenantId, customerId: c.id, contractId: c.contractId, versionNumber: p.version,
        status: 'DRAFT', validFrom: d(p.from), validTo: p.to ? d(p.to) : null,
        createdByUserId: f.amUserId, createdAt: now, updatedAt: now,
      },
    });
    await tx.pricingLine.create({
      data: {
        id: uuidv7(), tenantId: f.tenantId, customerId: c.id, scheduleId: id, lineKey: 'forfait',
        articleCode: 'INFOG', label: 'Infogérance', unit: 'mois', kind: 'FLAT_MONTHLY', mode: 'MANUAL',
        vatRatePercent: '20', quantity: '1', unitPrice: '1250',
      },
    });
    if (status === 'ACTIVE') {
      await tx.pricingSchedule.update({
        where: { id },
        data: { status: 'ACTIVE', activatedAt: now, activatedByUserId: f.adminUserId },
      });
    }
  });
  return id;
}

async function createIndex(f: Fixture, code: string) {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) =>
    tx.priceIndex.create({ data: { id, tenantId: f.tenantId, code, label: `Indice ${code}`, createdAt: now, updatedAt: now } }),
  );
  return id;
}

function indexValue(f: Fixture, indexId: string, p: { period: string; value: string; revision?: number; supersedesId?: string | null; reason?: string }) {
  return {
    id: uuidv7(), tenantId: f.tenantId, indexId, period: p.period, value: p.value, publishedAt: d(`${p.period}-27`),
    source: 'MANUAL' as const, revision: p.revision ?? 0, supersedesId: p.supersedesId ?? null,
    correctionReason: p.reason ?? null, enteredByUserId: f.adminUserId, createdAt: new Date(),
  };
}

function override(f: Fixture, p: { author: string; approvedBy?: string | null; status?: 'ACTIVE' | 'PENDING_APPROVAL'; requires?: boolean }) {
  const now = new Date();
  return {
    id: uuidv7(), tenantId: f.tenantId, customerId: f.customerA.id, contractId: f.customerA.contractId,
    lineKey: 'forfait', unitPrice: '1000', validFrom: d('2026-01-01'), validTo: d('2026-03-31'),
    reason: 'Geste commercial : incident de production', requiresSecondApproval: p.requires ?? true,
    status: p.status ?? 'PENDING_APPROVAL', authorUserId: p.author,
    approvedByUserId: p.approvedBy ?? null, approvedAt: p.approvedBy ? now : null,
    createdAt: now, updatedAt: now,
  };
}

describe('barèmes : versions sans chevauchement, versions engagées immuables', () => {
  test('deux versions ACTIVES d’un même contrat ne peuvent pas couvrir un même jour (EXCLUDE)', async () => {
    await createSchedule(fx, 'customerA', { version: 1, from: '2025-01-01', status: 'ACTIVE' });
    await expect(createSchedule(fx, 'customerA', { version: 2, from: '2025-06-01', to: '2025-12-31', status: 'ACTIVE' }))
      .rejects.toThrow(/exclusion constraint|pricing_schedules_no_overlap/i);
  });

  test('un brouillon peut chevaucher la version active (on prépare la révision)', async () => {
    await expect(createSchedule(fx, 'customerA', { version: 3, from: '2026-09-01' })).resolves.toBeTruthy();
  });

  test('clôturer la version active puis activer la suivante : accepté', async () => {
    const v1 = await createSchedule(fx, 'customerB', { version: 1, from: '2025-01-01', status: 'ACTIVE' });
    const v2 = await createSchedule(fx, 'customerB', { version: 2, from: '2026-09-01' });
    await withScope(admin(), async (tx) => {
      await tx.pricingSchedule.update({ where: { id: v1 }, data: { status: 'SUPERSEDED', validTo: d('2026-08-31'), supersededAt: new Date() } });
      await tx.pricingSchedule.update({ where: { id: v2 }, data: { status: 'ACTIVE', activatedAt: new Date(), activatedByUserId: fx.adminUserId } });
    });
    const rows = await withScope(admin(), (tx) => tx.pricingSchedule.findMany({ where: { contractId: fx.customerB.contractId }, orderBy: { versionNumber: 'asc' } }));
    expect(rows.map((r) => r.status)).toEqual(['SUPERSEDED', 'ACTIVE']);

    // … mais une fois SUPERSEDED, on ne rouvre pas, on ne prolonge pas.
    await expect(withScope(admin(), (tx) => tx.pricingSchedule.update({ where: { id: v1 }, data: { validTo: d('2026-12-31') } })))
      .rejects.toThrow(/fin de validité/);
    await expect(withScope(admin(), (tx) => tx.pricingSchedule.update({ where: { id: v1 }, data: { status: 'ACTIVE' } })))
      .rejects.toThrow(/transition/);
  });

  test('le contenu d’une version active est immuable, ses lignes aussi', async () => {
    // Contrat vierge (client B du second tenant) : aucune version active à chevaucher.
    const id = await createSchedule(other, 'customerB', { version: 1, from: '2030-01-01', to: '2030-12-31', status: 'ACTIVE' });
    const scope = adminScope(other.tenantId, other.adminUserId);
    await expect(withScope(scope, (tx) => tx.pricingSchedule.update({ where: { id }, data: { validFrom: d('2029-01-01') } })))
      .rejects.toThrow(/immuable/);
    await expect(withScope(scope, (tx) => tx.pricingLine.updateMany({ where: { scheduleId: id }, data: { unitPrice: '1' } })))
      .rejects.toThrow(/immuables/);
    await expect(withScope(scope, (tx) => tx.pricingLine.deleteMany({ where: { scheduleId: id } })))
      .rejects.toThrow(/immuables/);
    await expect(withScope(scope, (tx) => tx.pricingSchedule.delete({ where: { id } })))
      .rejects.toThrow(/suppression interdite/);
  });

  test('un brouillon se supprime, ses lignes avec (cascade)', async () => {
    const id = await createSchedule(fx, 'customerA', { version: 5, from: '2031-01-01' });
    await withScope(admin(), (tx) => tx.pricingSchedule.delete({ where: { id } }));
    const lines = await withScope(admin(), (tx) => tx.pricingLine.count({ where: { scheduleId: id } }));
    expect(lines).toBe(0);
  });

  test('cohérence : un barème du client A ne peut pas pointer le contrat de B (FK composite)', async () => {
    const now = new Date();
    await expect(
      withScope(admin(), (tx) =>
        tx.pricingSchedule.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerB.contractId,
            versionNumber: 99, validFrom: d('2025-01-01'), createdByUserId: fx.amUserId, createdAt: now, updatedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('barèmes : cloisonnement', () => {
  test('le commercial du client A ne voit ni les barèmes ni les lignes du client B', async () => {
    const am = internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId);
    const [s, l] = await withScope(am, async (tx) => [
      await tx.pricingSchedule.findMany({ where: { customerId: fx.customerB.id } }),
      await tx.pricingLine.findMany({ where: { customerId: fx.customerB.id } }),
    ]);
    expect(s).toEqual([]);
    expect(l).toEqual([]);
  });

  test('le client A LIT le barème de son contrat mais ne l’écrit pas', async () => {
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const rows = await withScope(client, (tx) => tx.pricingSchedule.findMany());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.customerId === fx.customerA.id)).toBe(true);
    const now = new Date();
    await expect(
      withScope(client, (tx) =>
        tx.pricingSchedule.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
            versionNumber: 50, validFrom: d('2040-01-01'), createdByUserId: fx.customerA.clientUserId, createdAt: now, updatedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test('inter-tenant : aucun barème d’un autre tenant n’est visible, aucun n’est inscriptible', async () => {
    await createSchedule(other, 'customerA', { version: 1, from: '2025-01-01', status: 'ACTIVE' });
    const seen = await withScope(admin(), (tx) => tx.pricingSchedule.findMany({ where: { tenantId: other.tenantId } }));
    expect(seen).toEqual([]);
    const now = new Date();
    await expect(
      withScope(admin(), (tx) =>
        tx.pricingSchedule.create({
          data: {
            id: uuidv7(), tenantId: other.tenantId, customerId: other.customerA.id, contractId: other.customerA.contractId,
            versionNumber: 7, validFrom: d('2040-01-01'), createdByUserId: fx.adminUserId, createdAt: now, updatedAt: now,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('indices : valeurs append-only, corrections chaînées', () => {
  test('une valeur ne se modifie ni ne se supprime', async () => {
    const idx = await createIndex(fx, 'SYNTEC');
    const v = indexValue(fx, idx, { period: '2025-07', value: '321.5' });
    await withScope(admin(), (tx) => tx.priceIndexValue.create({ data: v }));
    await expect(withScope(admin(), (tx) => tx.priceIndexValue.update({ where: { id: v.id }, data: { value: '999' } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withScope(admin(), (tx) => tx.priceIndexValue.delete({ where: { id: v.id } })))
      .rejects.toThrow(/permission denied/i);
  });

  test('une correction est une nouvelle ligne ; une seule originale et une seule correction par valeur', async () => {
    const idx = await createIndex(fx, 'INSEE_A');
    const v0 = indexValue(fx, idx, { period: '2025-07', value: '100' });
    await withScope(admin(), (tx) => tx.priceIndexValue.create({ data: v0 }));

    // Seconde « originale » pour la même période : refusée.
    await expect(withScope(admin(), (tx) => tx.priceIndexValue.create({ data: indexValue(fx, idx, { period: '2025-07', value: '101' }) })))
      .rejects.toThrow(/unique/i);
    // Correction sans motif : refusée.
    await expect(withScope(admin(), (tx) =>
      tx.priceIndexValue.create({ data: indexValue(fx, idx, { period: '2025-07', value: '101', revision: 1, supersedesId: v0.id }) }),
    )).rejects.toThrow(/check constraint/i);
    // Correction dans une AUTRE période : refusée (FK composite).
    await expect(withScope(admin(), (tx) =>
      tx.priceIndexValue.create({ data: indexValue(fx, idx, { period: '2025-08', value: '101', revision: 1, supersedesId: v0.id, reason: 'x' }) }),
    )).rejects.toThrow(/foreign key/i);

    const v1 = indexValue(fx, idx, { period: '2025-07', value: '101.2', revision: 1, supersedesId: v0.id, reason: 'erreur de saisie' });
    await withScope(admin(), (tx) => tx.priceIndexValue.create({ data: v1 }));
    // Deux corrections concurrentes de la même valeur : la seconde est refusée.
    await expect(withScope(admin(), (tx) =>
      tx.priceIndexValue.create({ data: indexValue(fx, idx, { period: '2025-07', value: '101.3', revision: 2, supersedesId: v0.id, reason: 'bis' }) }),
    )).rejects.toThrow(/unique/i);
  });

  test('indices lisibles par le portail client, inscriptibles par l’interne seulement', async () => {
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const seen = await withScope(client, (tx) => tx.priceIndex.findMany());
    expect(seen.map((i) => i.code)).toContain('SYNTEC');
    const now = new Date();
    await expect(withScope(client, (tx) =>
      tx.priceIndex.create({ data: { id: uuidv7(), tenantId: fx.tenantId, code: 'PIRATE', label: 'x', createdAt: now, updatedAt: now } }),
    )).rejects.toThrow(/row-level security/i);
  });

  test('inter-tenant : les indices d’un autre tenant sont invisibles et inécrivables', async () => {
    const theirs = await createIndex(other, 'SYNTEC');
    const seen = await withScope(admin(), (tx) => tx.priceIndex.findMany({ where: { tenantId: other.tenantId } }));
    expect(seen).toEqual([]);
    await expect(withScope(admin(), (tx) => tx.priceIndexValue.create({ data: { ...indexValue(fx, theirs, { period: '2026-07', value: '1' }), tenantId: other.tenantId } })))
      .rejects.toThrow(/row-level security|foreign key/i);
    // Et une valeur « chez moi » ne peut pas pointer la série de l'autre tenant (FK composite).
    await expect(withScope(admin(), (tx) => tx.priceIndexValue.create({ data: indexValue(fx, theirs, { period: '2026-07', value: '1' }) })))
      .rejects.toThrow(/foreign key/i);
  });
});

describe('catalogue de règles', () => {
  test('interne uniquement ; jamais supprimé ; cloisonné par tenant', async () => {
    const now = new Date();
    const id = uuidv7();
    await withScope(admin(), (tx) =>
      tx.pricingRule.create({
        data: { id, tenantId: fx.tenantId, code: 'grille-2026', type: 'GRID', label: 'Grille 2026', definition: { entries: [] }, createdAt: now, updatedAt: now },
      }),
    );
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    expect(await withScope(client, (tx) => tx.pricingRule.findMany())).toEqual([]);
    await expect(withScope(admin(), (tx) => tx.pricingRule.delete({ where: { id } }))).rejects.toThrow(/permission denied/i);
    const otherAdmin = adminScope(other.tenantId, other.adminUserId);
    expect(await withScope(otherAdmin, (tx) => tx.pricingRule.findMany())).toEqual([]);
  });
});

describe('dérogations : quatre yeux en base', () => {
  test('l’auteur ne peut pas être le second validateur (CHECK), à la création comme à la validation', async () => {
    await expect(withScope(admin(), (tx) =>
      tx.priceOverride.create({ data: override(fx, { author: fx.adminUserId, approvedBy: fx.adminUserId, status: 'ACTIVE' }) }),
    )).rejects.toThrow(/price_overrides_approver_ck|check constraint/i);

    const o = override(fx, { author: fx.amUserId });
    await withScope(admin(), (tx) => tx.priceOverride.create({ data: o }));
    await expect(withScope(admin(), (tx) =>
      tx.priceOverride.update({ where: { id: o.id }, data: { status: 'ACTIVE', approvedByUserId: fx.amUserId, approvedAt: new Date() } }),
    )).rejects.toThrow(/check constraint/i);
    // Le validateur distinct, lui, passe.
    await withScope(admin(), (tx) =>
      tx.priceOverride.update({ where: { id: o.id }, data: { status: 'ACTIVE', approvedByUserId: fx.adminUserId, approvedAt: new Date() } }),
    );
  });

  test('une dérogation exigeant la double validation ne peut pas être ACTIVE sans validateur', async () => {
    await expect(withScope(admin(), (tx) =>
      tx.priceOverride.create({ data: override(fx, { author: fx.amUserId, status: 'ACTIVE', requires: true }) }),
    )).rejects.toThrow(/check constraint/i);
  });

  test('motif vide ou période inversée : refusés', async () => {
    await expect(withScope(admin(), (tx) => tx.priceOverride.create({ data: { ...override(fx, { author: fx.amUserId }), reason: '   ' } })))
      .rejects.toThrow(/check constraint/i);
    await expect(withScope(admin(), (tx) =>
      tx.priceOverride.create({ data: { ...override(fx, { author: fx.amUserId }), validFrom: d('2026-05-01'), validTo: d('2026-04-01') } }),
    )).rejects.toThrow(/check constraint/i);
  });

  test('prix, période et motif sont figés ; aucune suppression', async () => {
    const o = override(fx, { author: fx.amUserId });
    await withScope(admin(), (tx) => tx.priceOverride.create({ data: o }));
    await expect(withScope(admin(), (tx) => tx.priceOverride.update({ where: { id: o.id }, data: { unitPrice: '1' } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withScope(admin(), (tx) => tx.priceOverride.delete({ where: { id: o.id } })))
      .rejects.toThrow(/permission denied/i);
  });

  test('invisibles du portail client et du commercial d’un autre portefeuille', async () => {
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    expect(await withScope(client, (tx) => tx.priceOverride.findMany())).toEqual([]);
    const amB = internalScope(fx.tenantId, [fx.customerB.id], fx.amUserId);
    expect(await withScope(amB, (tx) => tx.priceOverride.findMany({ where: { customerId: fx.customerA.id } }))).toEqual([]);
  });
});
