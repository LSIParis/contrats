import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { extractVariables } from '@lsi/domain';
import { z } from 'zod';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';

/**
 * Bibliothèque de clauses (brief §4). Classe « tenant » : mutualisée entre
 * clients. Une clause se VERSIONNE : publier un texte modifié crée une
 * nouvelle version ; les modèles et contrats pointent une version précise et
 * ne sont jamais modifiés par une mise à jour de la bibliothèque.
 */
const CATEGORY = z.enum([
  'OBJET', 'DUREE', 'PRIX', 'SLA', 'RESPONSABILITE', 'RGPD', 'CONFIDENTIALITE',
  'PROPRIETE_INTELLECTUELLE', 'ASSURANCE', 'RESILIATION', 'DIVERS',
]);

export const CreateClauseSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, 'code : majuscules, chiffres, _ et -'),
    category: CATEGORY,
    title: z.string().trim().min(1).max(200),
    bodyHtml: z.string().min(1).max(100_000),
  })
  .strict();

export const NewClauseVersionSchema = z
  .object({
    bodyHtml: z.string().min(1).max(100_000),
    title: z.string().trim().min(1).max(200).optional(),
    changeNote: z.string().trim().max(500).optional(),
  })
  .strict();

export const TemplateStructureSchema = z
  .object({
    clauses: z.array(z.object({ clauseVersionId: z.uuid(), required: z.boolean().default(false) }).strict()).min(1).max(200),
    defaultAnnexes: z
      .array(
        z.object({
          kind: z.enum(['SLA', 'ASSETS', 'PRICING_GRID', 'DPA_ART28', 'OTHER']),
          title: z.string().trim().min(1).max(200),
          bodyHtml: z.string().max(200_000).nullable().optional(),
        }).strict(),
      )
      .max(30)
      .default([]),
    /** Barème par défaut au format @lsi/pricing, repris à la création (lot 3). */
    defaultPricing: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  })
  .strict();

@Injectable()
export class ClauseLibraryService {
  list(scope: Scope, category?: string) {
    return withScope(scope, async (tx) => {
      const items = await tx.clauseLibraryItem.findMany({
        where: { archivedAt: null, ...(category ? { category: category as never } : {}) },
        orderBy: [{ category: 'asc' }, { code: 'asc' }],
      });
      const versions = await tx.clauseLibraryItemVersion.findMany({
        where: { id: { in: items.map((i) => i.currentVersionId).filter((x): x is string => !!x) } },
      });
      const byId = new Map(versions.map((v) => [v.id, v]));
      return {
        items: items.map((i) => ({
          id: i.id, code: i.code, category: i.category, title: i.title, isDemo: i.isDemo,
          currentVersion: i.currentVersionId ? pick(byId.get(i.currentVersionId)) : null,
        })),
      };
    });
  }

  get(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const item = await tx.clauseLibraryItem.findUnique({ where: { id }, include: { versions: { orderBy: { versionNumber: 'desc' } } } });
      if (!item) throw new NotFoundException('Clause introuvable');
      return { ...item, versions: item.versions.map(pick) };
    });
  }

  create(scope: Scope, input: z.infer<typeof CreateClauseSchema>, now: Date) {
    return withScope(scope, async (tx) => {
      const exists = await tx.clauseLibraryItem.findFirst({ where: { code: input.code }, select: { id: true } });
      if (exists) throw new ConflictException({ code: 'CLAUSE_CODE_DUP', detail: `Le code ${input.code} existe déjà.` });
      const id = uuidv7();
      const versionId = uuidv7();
      await tx.clauseLibraryItem.create({
        data: { id, tenantId: scope.tenantId, code: input.code, category: input.category, title: input.title, createdAt: now, updatedAt: now },
      });
      const body = sanitizeContractHtml(input.bodyHtml);
      await tx.clauseLibraryItemVersion.create({
        data: {
          id: versionId, tenantId: scope.tenantId, itemId: id, versionNumber: 1, bodyHtml: body,
          variables: extractVariables(body), createdByUserId: uuidOrNull(scope.userId), createdAt: now,
        },
      });
      await tx.clauseLibraryItem.update({ where: { id }, data: { currentVersionId: versionId } });
      return { id, versionId };
    });
  }

  newVersion(scope: Scope, id: string, input: z.infer<typeof NewClauseVersionSchema>, now: Date) {
    return withScope(scope, async (tx) => {
      const item = await tx.clauseLibraryItem.findUnique({ where: { id } });
      if (!item || item.archivedAt) throw new NotFoundException('Clause introuvable');
      const max = await tx.clauseLibraryItemVersion.aggregate({ where: { itemId: id }, _max: { versionNumber: true } });
      const versionId = uuidv7();
      const body = sanitizeContractHtml(input.bodyHtml);
      await tx.clauseLibraryItemVersion.create({
        data: {
          id: versionId, tenantId: scope.tenantId, itemId: id, versionNumber: (max._max.versionNumber ?? 0) + 1,
          bodyHtml: body, variables: extractVariables(body), changeNote: input.changeNote ?? null,
          createdByUserId: uuidOrNull(scope.userId), createdAt: now,
        },
      });
      await tx.clauseLibraryItem.update({
        where: { id },
        data: { currentVersionId: versionId, ...(input.title ? { title: input.title } : {}), updatedAt: now },
      });
      return { id, versionId };
    });
  }

  archive(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      const item = await tx.clauseLibraryItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundException('Clause introuvable');
      await tx.clauseLibraryItem.update({ where: { id }, data: { archivedAt: now, updatedAt: now } });
      return { id, archived: true };
    });
  }

  /**
   * Composition d'une version de modèle NON publiée : clauses épinglées,
   * annexes et barème par défaut. Le corps HTML du modèle est recomposé pour
   * que l'aperçu et l'export existants restent valables.
   */
  setTemplateStructure(scope: Scope, templateId: string, input: z.infer<typeof TemplateStructureSchema>, now: Date) {
    return withScope(scope, async (tx) => {
      const t = await tx.contractTemplate.findUnique({ where: { id: templateId } });
      if (!t || !t.currentVersionId) throw new NotFoundException('Modèle introuvable');
      const tv = await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId } });
      if (!tv) throw new NotFoundException('Modèle introuvable');
      if (tv.isImmutable) {
        throw new ConflictException({ code: 'TEMPLATE_PUBLISHED', detail: 'Version publiée : modifier le contenu crée d’abord une nouvelle version (enregistrer le contenu).' });
      }
      const versions = await tx.clauseLibraryItemVersion.findMany({
        where: { id: { in: input.clauses.map((c) => c.clauseVersionId) } },
        include: { item: true },
      });
      if (versions.length !== new Set(input.clauses.map((c) => c.clauseVersionId)).size) {
        throw new NotFoundException('Version de clause introuvable');
      }
      const byId = new Map(versions.map((v) => [v.id, v]));
      const codes = input.clauses.map((c) => byId.get(c.clauseVersionId)!.item.code);
      if (new Set(codes).size !== codes.length) {
        throw new ConflictException({ code: 'CLAUSE_TWICE', detail: 'Une même clause ne peut figurer deux fois dans un modèle.' });
      }

      await tx.templateClause.deleteMany({ where: { templateVersionId: tv.id } });
      await tx.templateClause.createMany({
        data: input.clauses.map((c, i) => ({
          tenantId: scope.tenantId, templateVersionId: tv.id, position: i + 1, clauseVersionId: c.clauseVersionId, required: c.required,
        })),
      });
      const bodyHtml = input.clauses
        .map((c, i) => {
          const v = byId.get(c.clauseVersionId)!;
          return `<h2>Article ${i + 1} — ${v.item.title}</h2>${v.bodyHtml}`;
        })
        .join('\n');
      await tx.contractTemplateVersion.update({
        where: { id: tv.id },
        data: {
          bodyHtml,
          defaultAnnexes: input.defaultAnnexes as never,
          defaultPricing: input.defaultPricing as never,
        },
      });
      await tx.contractTemplate.update({ where: { id: templateId }, data: { updatedAt: now } });
      return { templateVersionId: tv.id, clauses: input.clauses.length };
    });
  }

  /** Modèles PUBLIÉS utilisables pour créer un contrat (assistant de création). */
  publishedTemplates(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.contractTemplate.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, category: true, isDemo: true, currentVersionId: true },
      });
      return { items: rows };
    });
  }
}

function pick(v: any) {
  return v ? { id: v.id, versionNumber: v.versionNumber, bodyHtml: v.bodyHtml, variables: v.variables, changeNote: v.changeNote, createdAt: v.createdAt } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(id: string): string | null {
  return UUID.test(id) ? id : null;
}
