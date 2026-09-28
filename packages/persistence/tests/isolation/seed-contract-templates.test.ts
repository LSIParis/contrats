import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../support/fixtures.js';
import { seedContractTemplates, upgradeContractTemplateClause } from '../../src/seed/contract-templates.js';
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

describe('mise à jour d’une clause des contrats types (pnpm seed:contract-templates --upgrade CODE)', () => {
  const PARTIES_V1 = '<p>Entre {{prestataire.raisonSociale}}, SIREN {{prestataire.siren}}, dont le siège est situé {{prestataire.adresse}}, et {{client.raisonSociale}}.</p>';

  /** Installe les contrats types puis ramène CT-PARTIES à une ancienne rédaction (état de la production). */
  async function installedWithOldParties() {
    const slug = await tenant();
    const r = await seedContractTemplates(owner, { slug });
    const item = await owner.clauseLibraryItem.findUnique({ where: { tenantId_code: { tenantId: r.tenantId, code: 'CT-PARTIES' } } });
    await owner.clauseLibraryItemVersion.update({
      where: { id: item!.currentVersionId! },
      data: { bodyHtml: PARTIES_V1, variables: ['client.raisonSociale', 'prestataire.adresse', 'prestataire.raisonSociale', 'prestataire.siren'] },
    });
    return { slug, tenantId: r.tenantId, itemId: item!.id, oldVersionId: item!.currentVersionId! };
  }

  test('nouvelle version de la clause, brouillons recomposés (texte et variables), publiés intacts', async () => {
    const { slug, tenantId, itemId, oldVersionId } = await installedWithOldParties();
    // Un contrat type publié (immuable) qui épingle l'ancienne version : ne doit pas bouger.
    const published = await owner.contractTemplate.findFirst({ where: { tenantId, slug: 'supervision' }, include: { versions: true } });
    await owner.contractTemplateVersion.update({ where: { id: published!.versions[0]!.id }, data: { isImmutable: true, publishedAt: new Date() } });
    const publishedBody = published!.versions[0]!.bodyHtml;

    const r = await upgradeContractTemplateClause(owner, { slug, code: 'CT-PARTIES' });

    expect(r.created).toBe(true);
    expect(r.templatesUpdated.sort()).toEqual(['infogerance', 'rssi-externalise', 'sauvegarde-en-ligne']);
    expect(r.templatesSkipped).toEqual(['supervision']);

    const item = await owner.clauseLibraryItem.findUnique({ where: { id: itemId }, include: { versions: true } });
    expect(item!.versions).toHaveLength(2);
    const current = item!.versions.find((v) => v.id === item!.currentVersionId)!;
    expect(current.versionNumber).toBe(2);
    expect(current.bodyHtml).toContain('821 439 379');
    expect(current.variables).not.toContain('prestataire.siren');

    const t = await owner.contractTemplate.findFirst({ where: { tenantId, slug: 'infogerance' }, include: { versions: { include: { clauses: true } } } });
    const tv = t!.versions[0]!;
    expect(tv.clauses.map((c) => c.clauseVersionId)).toContain(current.id);
    expect(tv.clauses.map((c) => c.clauseVersionId)).not.toContain(oldVersionId);
    expect(tv.bodyHtml).toContain('821 439 379');
    expect(tv.bodyHtml.startsWith('<h2>Article 1 — Parties</h2>')).toBe(true);
    const required = (tv.variablesSchema as { required: string[] }).required;
    expect(required).not.toContain('prestataire.siren');
    expect(required).not.toContain('prestataire.adresse');
    expect(required).toContain('client.siren');

    const sup = await owner.contractTemplateVersion.findUnique({ where: { id: published!.versions[0]!.id }, include: { clauses: true } });
    expect(sup!.bodyHtml).toBe(publishedBody);
    expect(sup!.clauses.map((c) => c.clauseVersionId)).toContain(oldVersionId);
  });

  test('relancer ne crée pas de nouvelle version (texte déjà à jour)', async () => {
    const { slug } = await installedWithOldParties();
    await upgradeContractTemplateClause(owner, { slug, code: 'CT-PARTIES' });
    const again = await upgradeContractTemplateClause(owner, { slug, code: 'CT-PARTIES' });
    expect(again.created).toBe(false);
    expect(again.templatesUpdated).toEqual([]);
  });

  test('code inconnu : erreur explicite', async () => {
    const slug = await tenant();
    await expect(upgradeContractTemplateClause(owner, { slug, code: 'CT-INEXISTANTE' })).rejects.toThrow(/CT-INEXISTANTE/);
  });
});
