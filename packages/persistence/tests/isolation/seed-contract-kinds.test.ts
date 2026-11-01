import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../support/fixtures.js';
import { DEFAULT_COMMITMENT_TERMS, PREDEFINED_CONTRACT_KINDS, seedContractKinds } from '../../src/seed/contract-kinds.js';
import { uuidv7 } from '../../src/uuid.js';
import { createPrismaClient } from '../../src/prisma-client.js';

let owner: PrismaClient;
beforeAll(async () => {
  await applyMigrations();
  owner = createPrismaClient(process.env.DATABASE_URL);
});
afterAll(() => owner.$disconnect());

async function tenant() {
  const slug = `ck-${uuidv7().slice(-12)}`;
  const now = new Date();
  const t = await owner.tenant.create({ data: { id: uuidv7(), name: 'LSI Maintenance', slug, createdAt: now, updatedAt: now } });
  return { slug, id: t.id };
}

describe('types de contrats prédéfinis (pnpm seed:contract-kinds)', () => {
  test('crée les 7 types et les durées 0/12/24/36, sans aucun code tarif', async () => {
    const t = await tenant();
    const r = await seedContractKinds(owner, { slug: t.slug });
    expect(r.kindsCreated).toHaveLength(7);
    expect(r.termsCreated).toEqual([0, 12, 24, 36]);
    const kinds = await owner.contractKind.findMany({ where: { tenantId: t.id }, orderBy: { sortOrder: 'asc' } });
    expect(kinds.map((k) => k.prefix)).toEqual(['HM', 'MNT', 'M365', 'NXC', 'TIP', 'DPO', 'RSSI']);
    expect(kinds.every((k) => k.isSystem && k.systemKey && k.lastItemNumber === 0 && !k.contractTemplateId)).toBe(true);
    expect(await owner.priceGridItem.count({ where: { tenantId: t.id } })).toBe(0);
  });

  test('idempotent et conservateur : relancé, ne recrée ni ne modifie rien', async () => {
    const t = await tenant();
    await seedContractKinds(owner, { slug: t.slug });
    const m365 = await owner.contractKind.findFirstOrThrow({ where: { tenantId: t.id, systemKey: 'MICROSOFT_365' } });
    await owner.contractKind.update({ where: { id: m365.id }, data: { prefix: 'O365', label: 'Office 365' } });
    const again = await seedContractKinds(owner, { slug: t.slug });
    expect(again.kindsCreated).toEqual([]);
    expect(again.termsCreated).toEqual([]);
    expect(again.kindsKept).toHaveLength(PREDEFINED_CONTRACT_KINDS.length);
    const kept = await owner.contractKind.findUniqueOrThrow({ where: { id: m365.id } });
    expect([kept.prefix, kept.label]).toEqual(['O365', 'Office 365']);
    expect(await owner.contractKind.count({ where: { tenantId: t.id } })).toBe(7);
    expect(await owner.commitmentTerm.count({ where: { tenantId: t.id } })).toBe(DEFAULT_COMMITMENT_TERMS.length);
  });

  test('préfixe proposé déjà pris par un type utilisateur : signalé, non créé', async () => {
    const t = await tenant();
    const now = new Date();
    await owner.contractKind.create({ data: { id: uuidv7(), tenantId: t.id, prefix: 'NXC', label: 'Nexus', createdAt: now, updatedAt: now } });
    const r = await seedContractKinds(owner, { slug: t.slug });
    expect(r.kindsCreated).toHaveLength(6);
    expect(r.kindsBlocked).toEqual([expect.stringMatching(/Nextcloud.*NXC.*Nexus/)]);
  });
});
