import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../support/fixtures.js';
import { seedContractTemplates } from '../../src/seed/contract-templates.js';
import { ALL_CLAUSES, CONTRACT_TEMPLATES } from '../../src/seed/contract-templates-data.js';
import { uuidv7 } from '../../src/uuid.js';

let owner: PrismaClient;
beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
});
afterAll(() => owner.$disconnect());

async function tenant() {
  const slug = `ct-${uuidv7().slice(-12)}`;
  const now = new Date();
  await owner.tenant.create({ data: { id: uuidv7(), name: 'LSI Maintenance', slug, createdAt: now, updatedAt: now } });
  return slug;
}

describe('contrats types des propositions (données)', () => {
  test('les quatre slugs attendus par les modèles de propositions', () => {
    expect(CONTRACT_TEMPLATES.map((t) => t.slug).sort()).toEqual(['infogerance', 'rssi-externalise', 'sauvegarde-en-ligne', 'supervision']);
  });

  test('chaque clause composée existe, codes uniques', () => {
    const codes = ALL_CLAUSES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const t of CONTRACT_TEMPLATES) for (const code of t.clauses) expect(codes).toContain(code);
  });

  test('chaque contrat a sa grille tarifaire et son accord de traitement (article 28)', () => {
    for (const t of CONTRACT_TEMPLATES) {
      expect(t.annexes.map((a) => a.kind)).toEqual(expect.arrayContaining(['PRICING_GRID', 'DPA_ART28']));
    }
  });
});

describe('installation (pnpm seed:contract-templates)', () => {
  test('crée clauses et brouillons avec slug ; relancer ne duplique rien', async () => {
    const slug = await tenant();
    const first = await seedContractTemplates(owner, { slug });
    expect(first.clausesCreated).toBe(ALL_CLAUSES.length);
    expect(first.templatesCreated.sort()).toEqual(['infogerance', 'rssi-externalise', 'sauvegarde-en-ligne', 'supervision']);

    const again = await seedContractTemplates(owner, { slug });
    expect(again.clausesCreated).toBe(0);
    expect(again.templatesCreated).toEqual([]);
    expect(again.templatesKept.sort()).toEqual(first.templatesCreated.sort());

    const t = await owner.contractTemplate.findFirst({
      where: { tenantId: first.tenantId, slug: 'infogerance' },
      include: { versions: { include: { clauses: true } } },
    });
    expect(t).toMatchObject({ status: 'DRAFT', isDemo: false });
    expect(t!.versions[0]!.publishedAt).toBeNull();
    expect(t!.versions[0]!.clauses).toHaveLength(CONTRACT_TEMPLATES.find((x) => x.slug === 'infogerance')!.clauses.length);
  });

  test('ne modifie jamais un contrat type existant (même slug)', async () => {
    const slug = await tenant();
    const tn = await owner.tenant.findUnique({ where: { slug } });
    const now = new Date();
    await owner.contractTemplate.create({ data: { id: uuidv7(), tenantId: tn!.id, name: 'Mon contrat d’infogérance', slug: 'infogerance', category: 'MAINTENANCE', status: 'PUBLISHED', createdAt: now, updatedAt: now } });
    const r = await seedContractTemplates(owner, { slug });
    expect(r.templatesKept).toEqual(['infogerance']);
    const kept = await owner.contractTemplate.findFirst({ where: { tenantId: tn!.id, slug: 'infogerance' } });
    expect(kept).toMatchObject({ name: 'Mon contrat d’infogérance', status: 'PUBLISHED' });
  });
});
