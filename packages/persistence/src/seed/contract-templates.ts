/**
 * Installe les quatre contrats types des propositions (`pnpm seed:contract-templates`).
 *
 * - En BROUILLON, jamais publiés : un juriste les relit, puis un administrateur
 *   les publie depuis l'application (Modèles). Tant qu'ils ne sont pas publiés,
 *   la conversion d'une proposition signée reste refusée explicitement.
 * - Idempotent et conservateur : une clause (par code) ou un contrat type (par
 *   slug) déjà présent n'est JAMAIS modifié ; seuls les manquants sont créés.
 * - Atomique par contrat type.
 *
 * `--upgrade CODE` : applique la rédaction actuelle d'UNE clause (données
 * ci-dessous) — nouvelle version de la clause, puis recomposition des contrats
 * types NON publiés qui l'utilisent ; une version publiée n'est jamais touchée.
 *
 * Connexion : rôle propriétaire (SEED_DATABASE_URL, sinon DATABASE_URL), comme
 * les migrations. Tenant : SEED_TENANT_SLUG (défaut `lsi`).
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { uuidv7 } from '../uuid.js';
import { ALL_CLAUSES, CONTRACT_TEMPLATES } from './contract-templates-data.js';

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const varsOf = (html: string) => [...new Set([...html.matchAll(VAR_RE)].map((m) => m[1]!))].sort();

/** Texte composé, comme l'éditeur de modèles (clause-library.service) : exigé pour publier. */
const composeBody = (clauses: readonly { title: string; bodyHtml: string }[]) =>
  clauses.map((c, i) => `<h2>Article ${i + 1} — ${c.title}</h2>${c.bodyHtml}`).join('\n');

/** Schéma des variables : toutes celles des clauses et des annexes, requises. */
const variablesSchemaOf = (bodies: readonly string[]) => {
  const names = [...new Set(bodies.flatMap(varsOf))].sort();
  return { type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])), required: names };
};

export interface SeedContractTemplatesResult {
  readonly tenantId: string;
  readonly clausesCreated: number;
  readonly templatesCreated: string[];
  readonly templatesKept: string[];
}

export async function seedContractTemplates(
  db: PrismaClient,
  { slug = process.env.SEED_TENANT_SLUG ?? 'lsi', now = new Date() }: { slug?: string; now?: Date } = {},
): Promise<SeedContractTemplatesResult> {
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`Tenant « ${slug} » introuvable.`);
  const tenantId = tenant.id;

  // 1. Clauses de bibliothèque (codes CT-*), créées si absentes.
  let clausesCreated = 0;
  const versionOf = new Map<string, string>();
  for (const cl of ALL_CLAUSES) {
    let item = await db.clauseLibraryItem.findUnique({ where: { tenantId_code: { tenantId, code: cl.code } } });
    if (!item) {
      item = await db.$transaction(async (tx) => {
        const itemId = uuidv7();
        const versionId = uuidv7();
        await tx.clauseLibraryItem.create({ data: {
          id: itemId, tenantId, code: cl.code, category: cl.category, title: cl.title, isDemo: false, createdAt: now, updatedAt: now,
        } });
        await tx.clauseLibraryItemVersion.create({ data: {
          id: versionId, tenantId, itemId, versionNumber: 1, bodyHtml: cl.bodyHtml, variables: varsOf(cl.bodyHtml),
          changeNote: 'Version initiale (projet à faire valider par un juriste)', createdAt: now,
        } });
        return tx.clauseLibraryItem.update({ where: { id: itemId }, data: { currentVersionId: versionId } });
      });
      clausesCreated++;
    }
    if (!item.currentVersionId) throw new Error(`Clause ${cl.code} sans version courante.`);
    versionOf.set(cl.code, item.currentVersionId);
  }

  // 2. Contrats types (par slug), créés si absents, en brouillon.
  const templatesCreated: string[] = [];
  const templatesKept: string[] = [];
  for (const t of CONTRACT_TEMPLATES) {
    const existing = await db.contractTemplate.findFirst({ where: { tenantId, slug: t.slug } });
    if (existing) { templatesKept.push(t.slug); continue; }
    const bodies = [
      ...t.clauses.map((code) => ALL_CLAUSES.find((c) => c.code === code)!.bodyHtml),
      ...t.annexes.map((a) => a.bodyHtml ?? ''),
    ];
    const bodyHtml = composeBody(t.clauses.map((code) => ALL_CLAUSES.find((c) => c.code === code)!));
    await db.$transaction(async (tx) => {
      const templateId = uuidv7();
      const versionId = uuidv7();
      await tx.contractTemplate.create({ data: {
        id: templateId, tenantId, name: t.name, slug: t.slug, category: t.category, status: 'DRAFT', isDemo: false, createdAt: now, updatedAt: now,
      } });
      await tx.contractTemplateVersion.create({ data: {
        id: versionId, tenantId, templateId, versionNumber: 1, bodyHtml,
        variablesSchema: variablesSchemaOf(bodies),
        isImmutable: false, createdAt: now,
        defaultAnnexes: t.annexes.map((a) => ({ kind: a.kind, title: a.title, bodyHtml: a.bodyHtml })),
      } });
      await tx.templateClause.createMany({
        data: t.clauses.map((code, i) => ({
          tenantId, templateVersionId: versionId, position: i + 1, clauseVersionId: versionOf.get(code)!, required: false,
        })),
      });
      await tx.contractTemplate.update({ where: { id: templateId }, data: { currentVersionId: versionId } });
    });
    templatesCreated.push(t.slug);
  }
  return { tenantId, clausesCreated, templatesCreated, templatesKept };
}

export interface UpgradeClauseResult {
  readonly created: boolean;
  readonly templatesUpdated: string[];
  readonly templatesSkipped: string[];
}

/**
 * Applique la rédaction actuelle de la clause `code` : nouvelle version si le
 * texte a changé, puis les contrats types dont la version courante n'est PAS
 * publiée et qui épinglent une autre version de cette clause sont repointés et
 * recomposés (texte, schéma des variables). Les versions publiées (immuables)
 * sont laissées telles quelles (`templatesSkipped`) : les republier après relecture.
 */
export async function upgradeContractTemplateClause(
  db: PrismaClient,
  { slug = process.env.SEED_TENANT_SLUG ?? 'lsi', code, now = new Date() }: { slug?: string; code: string; now?: Date },
): Promise<UpgradeClauseResult> {
  const def = ALL_CLAUSES.find((c) => c.code === code);
  if (!def) throw new Error(`Clause ${code} inconnue des contrats types.`);
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`Tenant « ${slug} » introuvable.`);
  const tenantId = tenant.id;

  return db.$transaction(async (tx) => {
    const item = await tx.clauseLibraryItem.findUnique({ where: { tenantId_code: { tenantId, code } } });
    if (!item?.currentVersionId) throw new Error(`Clause ${code} absente : lancer d'abord pnpm seed:contract-templates.`);
    const current = await tx.clauseLibraryItemVersion.findUniqueOrThrow({ where: { id: item.currentVersionId } });

    let created = false;
    let versionId = current.id;
    if (current.bodyHtml !== def.bodyHtml) {
      const max = await tx.clauseLibraryItemVersion.aggregate({ where: { itemId: item.id }, _max: { versionNumber: true } });
      versionId = uuidv7();
      await tx.clauseLibraryItemVersion.create({ data: {
        id: versionId, tenantId, itemId: item.id, versionNumber: (max._max.versionNumber ?? 0) + 1,
        bodyHtml: def.bodyHtml, variables: varsOf(def.bodyHtml),
        changeNote: 'Rédaction mise à jour (pnpm seed:contract-templates --upgrade)', createdAt: now,
      } });
      await tx.clauseLibraryItem.update({ where: { id: item.id }, data: { currentVersionId: versionId, updatedAt: now } });
      created = true;
    }

    // Versions de modèles qui épinglent une autre version de la clause.
    const stale = await tx.templateClause.findMany({
      where: { tenantId, clauseVersion: { itemId: item.id }, clauseVersionId: { not: versionId } },
      select: { templateVersionId: true },
    });
    const templatesUpdated: string[] = [];
    const templatesSkipped: string[] = [];
    for (const templateVersionId of [...new Set(stale.map((x) => x.templateVersionId))]) {
      const tv = await tx.contractTemplateVersion.findUniqueOrThrow({ where: { id: templateVersionId }, include: { template: true } });
      if (tv.template.currentVersionId !== tv.id) continue; // ancienne version du modèle : historique
      const label = tv.template.slug ?? tv.template.name;
      if (tv.isImmutable) { templatesSkipped.push(label); continue; }
      await tx.templateClause.updateMany({
        where: { templateVersionId, clauseVersion: { itemId: item.id } },
        data: { clauseVersionId: versionId },
      });
      const pinned = await tx.templateClause.findMany({
        where: { templateVersionId }, orderBy: { position: 'asc' }, include: { clauseVersion: { include: { item: true } } },
      });
      const annexes = (tv.defaultAnnexes ?? []) as { bodyHtml?: string | null }[];
      await tx.contractTemplateVersion.update({ where: { id: tv.id }, data: {
        bodyHtml: composeBody(pinned.map((x) => ({ title: x.clauseVersion.item.title, bodyHtml: x.clauseVersion.bodyHtml }))),
        variablesSchema: variablesSchemaOf([
          ...pinned.map((x) => x.clauseVersion.bodyHtml), ...annexes.map((x) => x.bodyHtml ?? ''),
        ]) as Prisma.InputJsonValue,
      } });
      await tx.contractTemplate.update({ where: { id: tv.templateId }, data: { updatedAt: now } });
      templatesUpdated.push(label);
    }
    return { created, templatesUpdated, templatesSkipped };
  });
}

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const i = process.argv.indexOf('--upgrade');
    if (i > 0) {
      const code = process.argv[i + 1];
      if (!code) throw new Error('Usage : --upgrade CODE (ex. CT-PARTIES)');
      const r = await upgradeContractTemplateClause(db, { code });
      console.log(r.created ? `✔ ${code} : nouvelle version créée.` : `  ${code} : texte déjà à jour.`);
      console.log(`✔ Contrats types recomposés : ${r.templatesUpdated.join(', ') || 'aucun'}.`);
      if (r.templatesSkipped.length) console.log(`  Publiés, non modifiés (à republier après relecture) : ${r.templatesSkipped.join(', ')}.`);
      return;
    }
    const r = await seedContractTemplates(db);
    console.log(`✔ Clauses créées : ${r.clausesCreated}.`);
    console.log(`✔ Contrats types créés (brouillons, à relire puis publier) : ${r.templatesCreated.join(', ') || 'aucun'}.`);
    if (r.templatesKept.length) console.log(`  Déjà présents, non modifiés : ${r.templatesKept.join(', ')}.`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /contract-templates\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
