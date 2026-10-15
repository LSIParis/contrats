import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import type { Tx } from '../pricing/pricing-snapshot.js';
import type { CreateKind, CreateTerm, UpdateKind, UpdateTerm } from './contract-kinds.schemas.js';

/**
 * Types de contrats et durées d'engagement du tenant
 * (docs/contrats/13-types-contrats.md) — `pricing.grid.manage` pour écrire.
 *
 * Aucune règle propre aux types prédéfinis hors la suppression (interdite,
 * on archive) : un type créé ici a exactement le même comportement. La base
 * impose les mêmes règles (triggers, migration 34) ; les contrôles ci-dessous
 * ne servent qu'à répondre 409 avec un code stable plutôt qu'une erreur SQL.
 */

type KindRow = Awaited<ReturnType<Tx['contractKind']['findMany']>>[number];
type TermRow = Awaited<ReturnType<Tx['commitmentTerm']['findMany']>>[number];

export function kindView(k: KindRow, itemCount?: number) {
  return {
    id: k.id, prefix: k.prefix, label: k.label, description: k.description, sortOrder: k.sortOrder,
    isSystem: k.isSystem, systemKey: k.systemKey, contractTemplateId: k.contractTemplateId,
    /** Préfixe figé : au moins un code de base a été créé. */
    prefixLocked: k.lastItemNumber > 0,
    ...(itemCount !== undefined ? { itemCount } : {}),
    archivedAt: k.archivedAt, createdAt: k.createdAt, updatedAt: k.updatedAt,
  };
}

export function termView(t: TermRow) {
  return { id: t.id, months: t.months, label: t.label, archivedAt: t.archivedAt };
}

export function actor(scope: Scope): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.userId) ? scope.userId : null;
}

const prefixTaken = (prefix: string) =>
  new ConflictException({ code: 'PREFIX_TAKEN', message: `Le préfixe ${prefix} est déjà utilisé par un autre type de contrat.` });

/** Erreurs levées par les triggers de la migration 34 → 409 lisible. */
export function translateDbError(e: unknown): never {
  const err = e as { code?: string; message?: string; meta?: { target?: unknown } };
  if (err.code === 'P2002') {
    throw new ConflictException({ code: 'DUPLICATE', message: 'Valeur déjà utilisée (contrainte d’unicité).' });
  }
  const m = /(type de contrat [^\n"]*?(?:interdite \(archiver\)|non modifiable|ne recule pas))/.exec(err.message ?? '');
  if (m) throw new ConflictException({ code: 'KIND_GUARD', message: m[1] });
  throw e;
}

@Injectable()
export class ContractKindsService {
  list(scope: Scope, includeArchived: boolean) {
    return withScope(scope, async (tx) => {
      const kinds = await tx.contractKind.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        include: { _count: { select: { items: true } } },
      });
      return { items: kinds.map((k) => kindView(k, k._count.items)) };
    });
  }

  get(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const k = await this.kindOrThrow(tx, id);
      return kindView(k, await tx.priceGridItem.count({ where: { contractKindId: k.id } }));
    });
  }

  async create(scope: Scope, body: CreateKind, now: Date) {
    try {
      return await withScope(scope, async (tx) => {
        if (await tx.contractKind.findFirst({ where: { prefix: body.prefix }, select: { id: true } })) throw prefixTaken(body.prefix);
        await this.templateOrThrow(tx, body.contractTemplateId);
        return kindView(
          await tx.contractKind.create({
            data: {
              id: uuidv7(), tenantId: scope.tenantId, prefix: body.prefix, label: body.label,
              description: body.description ?? null, sortOrder: body.sortOrder ?? 0,
              contractTemplateId: body.contractTemplateId ?? null,
              createdByUserId: actor(scope), updatedByUserId: actor(scope), createdAt: now, updatedAt: now,
            },
          }),
          0,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw prefixTaken(body.prefix);
      translateDbError(e);
    }
  }

  async update(scope: Scope, id: string, body: UpdateKind, now: Date) {
    try {
      return await withScope(scope, async (tx) => {
        const k = await this.kindOrThrow(tx, id);
        if (body.prefix !== undefined && body.prefix !== k.prefix) {
          if (k.lastItemNumber > 0) {
            throw new ConflictException({
              code: 'PREFIX_LOCKED',
              message: `Le préfixe ${k.prefix} est utilisé par des codes tarifs : il n'est plus modifiable.`,
            });
          }
          if (await tx.contractKind.findFirst({ where: { prefix: body.prefix }, select: { id: true } })) throw prefixTaken(body.prefix);
        }
        if (body.contractTemplateId) await this.templateOrThrow(tx, body.contractTemplateId);
        const updated = await tx.contractKind.update({
          where: { id: k.id },
          data: {
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.contractTemplateId !== undefined ? { contractTemplateId: body.contractTemplateId } : {}),
            updatedByUserId: actor(scope), updatedAt: now,
          },
        });
        return kindView(updated, await tx.priceGridItem.count({ where: { contractKindId: k.id } }));
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002' && body.prefix) throw prefixTaken(body.prefix);
      translateDbError(e);
    }
  }

  setArchived(scope: Scope, id: string, archived: boolean, now: Date) {
    return withScope(scope, async (tx) => {
      const k = await this.kindOrThrow(tx, id);
      if ((k.archivedAt !== null) === archived) return kindView(k);
      return kindView(
        await tx.contractKind.update({
          where: { id: k.id },
          data: { archivedAt: archived ? now : null, updatedByUserId: actor(scope), updatedAt: now },
        }),
      );
    });
  }

  /** Suppression : type créé par l'utilisateur et sans aucun code. Sinon, archiver. */
  async remove(scope: Scope, id: string) {
    try {
      return await withScope(scope, async (tx) => {
        const k = await this.kindOrThrow(tx, id);
        if (k.isSystem) {
          throw new ConflictException({ code: 'SYSTEM_KIND', message: `« ${k.label} » est un type prédéfini : il s'archive, il ne se supprime pas.` });
        }
        if (k.lastItemNumber > 0) {
          throw new ConflictException({ code: 'KIND_IN_USE', message: `« ${k.label} » a des codes tarifs : il s'archive, il ne se supprime pas.` });
        }
        await tx.contractKind.delete({ where: { id: k.id } });
        return { deleted: true };
      });
    } catch (e) {
      translateDbError(e);
    }
  }

  // --- Durées d'engagement ----------------------------------------------------

  listTerms(scope: Scope, includeArchived: boolean) {
    return withScope(scope, async (tx) => ({
      items: (await tx.commitmentTerm.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { months: 'asc' } })).map(termView),
    }));
  }

  async createTerm(scope: Scope, body: CreateTerm, now: Date) {
    const exists = () => new ConflictException({ code: 'TERM_EXISTS', message: `La durée de ${body.months} mois existe déjà.` });
    try {
      return await withScope(scope, async (tx) => {
        if (await tx.commitmentTerm.findFirst({ where: { months: body.months }, select: { id: true } })) throw exists();
        return termView(
          await tx.commitmentTerm.create({ data: { id: uuidv7(), tenantId: scope.tenantId, months: body.months, label: body.label, createdAt: now, updatedAt: now } }),
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw exists();
      throw e;
    }
  }

  updateTerm(scope: Scope, months: number, body: UpdateTerm, now: Date) {
    return withScope(scope, async (tx) => {
      const t = await tx.commitmentTerm.findFirst({ where: { months } });
      if (!t) throw new NotFoundException(`Durée de ${months} mois introuvable`);
      return termView(
        await tx.commitmentTerm.update({
          where: { id: t.id },
          data: {
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.archived !== undefined ? { archivedAt: body.archived ? (t.archivedAt ?? now) : null } : {}),
            updatedAt: now,
          },
        }),
      );
    });
  }

  private async kindOrThrow(tx: Tx, id: string) {
    const k = await tx.contractKind.findFirst({ where: { id } });
    if (!k) throw new NotFoundException(`Type de contrat ${id} introuvable`);
    return k;
  }

  private async templateOrThrow(tx: Tx, id: string | null | undefined) {
    if (!id) return;
    if (!(await tx.contractTemplate.findFirst({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException(`Modèle de contrat ${id} introuvable`);
    }
  }
}
