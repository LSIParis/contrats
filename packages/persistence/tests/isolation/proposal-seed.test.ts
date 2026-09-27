import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { runProposalTemplatesSeed } from '../../prisma/seed/proposal-templates/cli';

/**
 * Seed des modèles de proposition (annexe C) sur une VRAIE base, via le dépôt
 * Prisma 5 adapté (`repository.ts`) : premier passage, idempotence, protection
 * des modèles modifiés dans l'interface (`userModifiedAt`), `--force`,
 * `--dry-run`. Les mêmes règles sont testées en mémoire par
 * test/seed/proposal-templates.test.ts (fichiers de l'annexe C).
 */
let owner: PrismaClient;
let fx: Fixture;
let fx2: Fixture;
let tenantSlug: string;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  fx2 = await seedTwoCustomers();
  tenantSlug = (await owner.tenant.findUniqueOrThrow({ where: { id: fx.tenantId } })).slug;
});

describe('seed de l’annexe C sur PostgreSQL (dépôt Prisma 5)', () => {
  test('premier passage : 4 modèles, 55 sections, 52 lignes, 5 contenus ; second passage inchangé', async () => {
    const r1 = await runProposalTemplatesSeed(owner, [`--tenant=${tenantSlug}`]);
    expect(Object.values(r1.templates)).toEqual(['CREATED', 'CREATED', 'CREATED', 'CREATED']);
    expect(await owner.proposalTemplate.count({ where: { tenantId: fx.tenantId } })).toBe(4);
    expect(await owner.proposalTemplateSection.count({ where: { tenantId: fx.tenantId } })).toBe(55);
    expect(await owner.proposalTemplatePricingLine.count({ where: { tenantId: fx.tenantId } })).toBe(52);
    expect(await owner.contentLibraryItem.count({ where: { tenantId: fx.tenantId } })).toBe(5);
    // Contrats types absents : avertissement, sans blocage.
    expect(r1.warnings.join()).toMatch(/rssi-externalise/);
    const r2 = await runProposalTemplatesSeed(owner, [`--tenant=${tenantSlug}`]);
    expect(Object.values(r2.templates)).toEqual(['UNCHANGED', 'UNCHANGED', 'UNCHANGED', 'UNCHANGED']);
    expect(Object.values(r2.library).every((o) => o === 'UNCHANGED')).toBe(true);
  });

  test('un modèle modifié dans l’interface est ignoré ; --force restaure la version du seed', async () => {
    await owner.proposalTemplate.update({
      where: { tenantId_slug: { tenantId: fx.tenantId, slug: 'rssi' } },
      data: { name: 'RSSI maison', userModifiedAt: new Date() },
    });
    const r = await runProposalTemplatesSeed(owner, [`--tenant=${tenantSlug}`]);
    expect(r.templates.rssi).toBe('SKIPPED_MODIFIED');
    expect((await owner.proposalTemplate.findFirstOrThrow({ where: { tenantId: fx.tenantId, slug: 'rssi' } })).name).toBe('RSSI maison');
    const f = await runProposalTemplatesSeed(owner, [`--tenant=${tenantSlug}`, '--force']);
    expect(f.templates.rssi).toBe('UPDATED');
    const t = await owner.proposalTemplate.findFirstOrThrow({ where: { tenantId: fx.tenantId, slug: 'rssi' } });
    expect(t.name).toBe('RSSI externalisé');
    expect(t.userModifiedAt).toBeNull();
    expect(await owner.proposalTemplatePricingLine.count({ where: { templateId: t.id } })).toBe(9);
  });

  test('--dry-run n’écrit rien sur un autre tenant', async () => {
    const slug2 = (await owner.tenant.findUniqueOrThrow({ where: { id: fx2.tenantId } })).slug;
    const r = await runProposalTemplatesSeed(owner, [`--tenant=${slug2}`, '--dry-run']);
    expect(r.templates.infogerance).toBe('CREATED');
    expect(await owner.proposalTemplate.count({ where: { tenantId: fx2.tenantId } })).toBe(0);
  });
});

