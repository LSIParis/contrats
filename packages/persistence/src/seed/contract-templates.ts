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
 * Connexion : rôle propriétaire (SEED_DATABASE_URL, sinon DATABASE_URL), comme
 * les migrations. Tenant : SEED_TENANT_SLUG (défaut `lsi`).
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../uuid.js';
import { ALL_CLAUSES, CONTRACT_TEMPLATES } from './contract-templates-data.js';

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const varsOf = (html: string) => [...new Set([...html.matchAll(VAR_RE)].map((m) => m[1]!))].sort();

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
    const names = [...new Set(bodies.flatMap(varsOf))].sort();
    // Texte composé, comme l'éditeur de modèles (clause-library.service) : il
    // est exigé pour publier et sert d'aperçu du modèle.
    const bodyHtml = t.clauses
      .map((code, i) => {
        const c = ALL_CLAUSES.find((x) => x.code === code)!;
        return `<h2>Article ${i + 1} — ${c.title}</h2>${c.bodyHtml}`;
      })
      .join('\n');
    await db.$transaction(async (tx) => {
      const templateId = uuidv7();
      const versionId = uuidv7();
      await tx.contractTemplate.create({ data: {
        id: templateId, tenantId, name: t.name, slug: t.slug, category: t.category, status: 'DRAFT', isDemo: false, createdAt: now, updatedAt: now,
      } });
      await tx.contractTemplateVersion.create({ data: {
        id: versionId, tenantId, templateId, versionNumber: 1, bodyHtml,
        variablesSchema: { type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])), required: names },
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

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
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
