import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../support/fixtures.js';
import { DEMO_CLAUSES, seedDemo } from '../../src/seed/demo.js';
import { uuidv7 } from '../../src/uuid.js';

let owner: PrismaClient;
beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
});
afterAll(() => owner.$disconnect());

describe('jeu de démonstration (pnpm seed)', () => {
  test('crée tenant, clients fictifs, clauses et modèle publié — idempotent', async () => {
    const slug = `demo-${uuidv7().slice(-12)}`;
    const first = await seedDemo(owner, { slug });
    const again = await seedDemo(owner, { slug });
    expect(again).toEqual(first);
    expect(first).toMatchObject({ customers: 3, clauses: DEMO_CLAUSES.length, templates: 1 });
    const tpl = await owner.contractTemplate.findFirst({ where: { tenantId: first.tenantId, isDemo: true }, include: { versions: { include: { clauses: true } } } });
    expect(tpl!.status).toBe('PUBLISHED');
    expect(tpl!.versions[0]!.clauses).toHaveLength(DEMO_CLAUSES.length);
    const customers = await owner.customer.findMany({ where: { tenantId: first.tenantId } });
    expect(customers.every((c) => c.name.startsWith('Démo — '))).toBe(true);
  });
});
