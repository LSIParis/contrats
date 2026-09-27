/**
 * Accès aux données du seed, derrière une interface pour pouvoir tester l'idempotence
 * sans base (implémentation mémoire) et brancher Prisma en réel.
 *
 * Les modèles Prisma attendus sont décrits dans `proposal-templates.prisma` (fragment de
 * référence). Si les modèles du dépôt diffèrent, adapter UNIQUEMENT `mapTemplateToPrisma`
 * et `createPrismaSeedRepository` : les fichiers JSON restent la source de vérité.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { uuidv7 } from "../../../src/uuid.js";
import type { LibraryItemSeed, ProposalTemplateSeed } from "./schema";

export interface SeedState {
  id: string;
  seedVersion: number | null;
  seedChecksum: string | null;
  /** Renseigné par l'application à toute modification faite dans l'interface. */
  userModifiedAt: Date | null;
}

export interface SeedRepository {
  findTenantIdBySlug(slug: string): Promise<string | null>;
  contractTemplateExists(tenantId: string, slug: string): Promise<boolean>;
  findLibraryItem(tenantId: string, key: string): Promise<SeedState | null>;
  saveLibraryItem(tenantId: string, item: LibraryItemSeed, checksum: string, existingId?: string): Promise<void>;
  findTemplate(tenantId: string, slug: string): Promise<SeedState | null>;
  /** Crée ou remplace intégralement (sections, lignes) dans une transaction. */
  saveTemplate(tenantId: string, t: ProposalTemplateSeed, checksum: string, existingId?: string): Promise<void>;
}

/* ---------------------------------------------------------------- Prisma ---- */

/**
 * Adaptation au dépôt (annexe C, règle 2) : Prisma 5.22 (`prisma-client-js`),
 * identifiants générés par l'application (UUIDv7, pas de défaut en base),
 * horodatages explicites, relations composites (template_id, tenant_id) et
 * tenant_id porté par les sections et lignes (RLS de classe « tenant »).
 * Seuls `mapTemplateToPrisma` et `createPrismaSeedRepository` sont adaptés.
 *
 * Le seed s'exécute avec le rôle PROPRIÉTAIRE (DATABASE_URL, comme les
 * migrations — deploy/migrate.sh) : il prépare des données de référence du
 * tenant, hors réseau, sans entrée utilisateur.
 */
export type PrismaLike = Pick<
  PrismaClient,
  | 'tenant'
  | 'contractTemplate'
  | 'contentLibraryItem'
  | 'proposalTemplate'
  | 'proposalTemplateSection'
  | 'proposalTemplatePricingLine'
  | '$transaction'
>;

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export function mapTemplateToPrisma(t: ProposalTemplateSeed) {
  return {
    template: {
      slug: t.slug,
      name: t.name,
      description: t.description,
      target: t.target,
      contractTemplateSlug: t.contractTemplateSlug,
      acceptanceMode: t.acceptanceMode,
      providerCountersign: t.providerCountersign,
      validityDays: t.validityDays,
      followUps: json(t.followUps),
      vatRatePercent: t.vatRatePercent,
      currency: t.currency,
      tags: t.tags,
      pricingChoices: json(t.pricing.choices),
      pricingRules: json(t.pricing.rules),
      controlCases: json(t.controlCases),
    },
    sections: t.sections.map((s, position) => ({
      position,
      key: s.key,
      title: s.title,
      kind: s.kind,
      body: s.body ?? null,
      libraryItemKey: s.libraryKey ?? null,
      guidance: s.guidance ?? null,
      aiAssist: s.aiAssist,
      optional: s.optional,
      validationStatus: s.validationStatus,
    })),
    lines: t.pricing.lines.map((l, position) => ({
      position,
      key: l.key,
      label: l.label,
      description: l.description ?? null,
      kind: l.kind,
      unit: l.unit,
      recurrence: l.recurrence,
      group: l.group,
      quantity: l.quantity ? json(l.quantity) : Prisma.JsonNull,
      pricing: json(l.pricing),
      priceFrom: l.priceFrom,
      priceStatus: l.priceStatus,
      priceStatusByChoice: l.priceStatusByChoice ? json(l.priceStatusByChoice) : Prisma.JsonNull,
      priceSource: l.priceSource,
      setupLineKey: l.setupLineKey ?? null,
      indexation: l.indexation ? json(l.indexation) : Prisma.JsonNull,
    })),
  };
}

export function createPrismaSeedRepository(prisma: PrismaLike, now: () => Date = () => new Date()): SeedRepository {
  const state = (
    row: { id: string; seedVersion: number | null; seedChecksum: string | null; userModifiedAt: Date | null } | null,
  ): SeedState | null =>
    row ? { id: row.id, seedVersion: row.seedVersion, seedChecksum: row.seedChecksum, userModifiedAt: row.userModifiedAt } : null;
  const stateSelect = { id: true, seedVersion: true, seedChecksum: true, userModifiedAt: true } as const;

  return {
    async findTenantIdBySlug(slug) {
      const row = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
      return row?.id ?? null;
    },
    async contractTemplateExists(tenantId, slug) {
      // `contract_templates.slug` (migration 31) : correspondance modèle de proposition → contrat type.
      return !!(await prisma.contractTemplate.findFirst({ where: { tenantId, slug }, select: { id: true } }));
    },
    async findLibraryItem(tenantId, key) {
      return state(
        await prisma.contentLibraryItem.findUnique({ where: { tenantId_key: { tenantId, key } }, select: stateSelect }),
      );
    },
    async saveLibraryItem(tenantId, item, checksum, existingId) {
      const at = now();
      const data = {
        title: item.title,
        folder: item.folder,
        body: item.body,
        requiresLegalReview: item.requiresLegalReview,
        seedVersion: item.seedVersion,
        seedChecksum: checksum,
        userModifiedAt: null,
        updatedAt: at,
      };
      if (existingId) {
        await prisma.contentLibraryItem.update({ where: { id: existingId }, data: { ...data, version: { increment: 1 } } });
      } else {
        await prisma.contentLibraryItem.create({ data: { ...data, id: uuidv7(), tenantId, key: item.key, createdAt: at } });
      }
    },
    async findTemplate(tenantId, slug) {
      return state(
        await prisma.proposalTemplate.findUnique({ where: { tenantId_slug: { tenantId, slug } }, select: stateSelect }),
      );
    },
    async saveTemplate(tenantId, t, checksum, existingId) {
      const m = mapTemplateToPrisma(t);
      const at = now();
      await prisma.$transaction(async (tx) => {
        const data = { ...m.template, seedVersion: t.seedVersion, seedChecksum: checksum, userModifiedAt: null, updatedAt: at };
        let id = existingId;
        if (id) {
          await tx.proposalTemplate.update({ where: { id }, data });
          await tx.proposalTemplateSection.deleteMany({ where: { templateId: id } });
          await tx.proposalTemplatePricingLine.deleteMany({ where: { templateId: id } });
        } else {
          id = uuidv7();
          await tx.proposalTemplate.create({ data: { ...data, id, tenantId, createdAt: at } });
        }
        const templateId = id;
        await tx.proposalTemplateSection.createMany({
          data: m.sections.map((s) => ({ ...s, id: uuidv7(), tenantId, templateId })),
        });
        await tx.proposalTemplatePricingLine.createMany({
          data: m.lines.map((l) => ({ ...l, id: uuidv7(), tenantId, templateId })),
        });
      });
    },
  };
}

/* ---------------------------------------------------------------- Mémoire ---- */

export interface MemoryStore {
  tenants: Map<string, string>; // slug -> id
  contractTemplates: Set<string>; // `${tenantId}:${slug}`
  library: Map<string, SeedState & { item: LibraryItemSeed }>;
  templates: Map<string, SeedState & { template: ProposalTemplateSeed; writes: number }>;
}

export function createMemorySeedRepository(store: MemoryStore): SeedRepository {
  let seq = 0;
  return {
    async findTenantIdBySlug(slug) {
      return store.tenants.get(slug) ?? null;
    },
    async contractTemplateExists(tenantId, slug) {
      return store.contractTemplates.has(`${tenantId}:${slug}`);
    },
    async findLibraryItem(tenantId, key) {
      return store.library.get(`${tenantId}:${key}`) ?? null;
    },
    async saveLibraryItem(tenantId, item, checksum, existingId) {
      const k = `${tenantId}:${item.key}`;
      store.library.set(k, {
        id: existingId ?? `lib-${++seq}`,
        seedVersion: item.seedVersion,
        seedChecksum: checksum,
        userModifiedAt: null,
        item,
      });
    },
    async findTemplate(tenantId, slug) {
      return store.templates.get(`${tenantId}:${slug}`) ?? null;
    },
    async saveTemplate(tenantId, t, checksum, existingId) {
      const k = `${tenantId}:${t.slug}`;
      const prev = store.templates.get(k);
      store.templates.set(k, {
        id: existingId ?? `tpl-${++seq}`,
        seedVersion: t.seedVersion,
        seedChecksum: checksum,
        userModifiedAt: null,
        template: t,
        writes: (prev?.writes ?? 0) + 1,
      });
    },
  };
}
