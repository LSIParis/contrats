import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { priceInEffect } from '@lsi/domain';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { dayToDate, isoDay, todayParis, type Tx } from '../pricing/pricing-snapshot.js';
import type { UploadedDocument } from '../common/http-io.js';
import type { CreateItem, DurationPrice, Search, UpdateItem } from './contract-kinds.schemas.js';
import { actor, kindView, termView, translateDbError } from './contract-kinds.service.js';
import { formatGridCsv, parseGridCsv, type GridCsvExportItem } from './price-grid-csv.js';

/**
 * Grille tarifaire d'un type de contrat (docs/contrats/13-types-contrats.md) :
 * codes de base × durées d'engagement, prix historisés.
 *
 *  - Les codes sont attribués par la BASE (triggers, migration 34) ; ce
 *    service ne les calcule jamais.
 *  - Un changement de prix est une NOUVELLE ligne datée ; l'ancienne reste
 *    consultable (historique). Un prix identique à celui déjà en vigueur à la
 *    même date n'est pas réécrit (import idempotent).
 *  - Une version non proposée est archivée, jamais supprimée : son code reste
 *    à elle et revient tel quel si la durée est de nouveau proposée.
 *  - La recherche (sélecteur des documents) ne renvoie que des versions
 *    actives AYANT un prix en vigueur à la date demandée.
 */

type PriceRow = Awaited<ReturnType<Tx['priceGridPrice']['findMany']>>[number];

const dec = (d: { toString(): string } | null | undefined): string | null => (d === null || d === undefined ? null : d.toString());

function priceView(p: PriceRow) {
  return {
    id: p.id, effectiveFrom: isoDay(p.effectiveFrom), unitPrice: dec(p.unitPrice)!, purchasePrice: dec(p.purchasePrice),
    enteredByUserId: p.enteredByUserId, createdAt: p.createdAt,
  };
}

const sameDecimal = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Number(a) === Number(b));

/** Prix en vigueur et prochain prix programmé d'une version, à `on`. */
function variantPrices(prices: readonly PriceRow[], on: string) {
  const views = prices.map(priceView);
  const current = priceInEffect(views, on);
  const upcoming = views.filter((p) => p.effectiveFrom > on).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0] ?? null;
  return { current, upcoming };
}

const ITEM_INCLUDE = {
  variants: {
    include: { term: true, prices: { orderBy: [{ effectiveFrom: 'desc' as const }, { id: 'desc' as const }] } },
  },
};

type ItemWithVariants = Awaited<ReturnType<Tx['priceGridItem']['findMany']>>[number] & {
  variants: (Awaited<ReturnType<Tx['priceGridVariant']['findMany']>>[number] & {
    term: Awaited<ReturnType<Tx['commitmentTerm']['findMany']>>[number];
    prices: PriceRow[];
  })[];
};

function itemView(i: ItemWithVariants, on: string) {
  return {
    id: i.id, code: i.code, number: i.number, label: i.label, description: i.description, unit: i.unit,
    recurrence: i.recurrence, vatRatePercent: dec(i.vatRatePercent)!, sortOrder: i.sortOrder, archivedAt: i.archivedAt,
    variants: i.variants
      .slice()
      .sort((a, b) => a.term.months - b.term.months)
      .map((v) => {
        const { current, upcoming } = variantPrices(v.prices, on);
        return {
          code: v.code, months: v.term.months, archivedAt: v.archivedAt,
          unitPrice: current?.unitPrice ?? null, purchasePrice: current?.purchasePrice ?? null,
          effectiveFrom: current?.effectiveFrom ?? null, upcoming,
        };
      }),
  };
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly effectiveFrom: string;
  readonly created: string[];
  readonly updated: string[];
  readonly pricesAdded: number;
  readonly variantsWithdrawn: number;
  readonly errors: { line: number; message: string }[];
}

class DryRunRollback extends Error {
  constructor(readonly report: ImportReport) {
    super('dry-run');
  }
}

@Injectable()
export class PriceGridService {
  /** Grille complète d'un type : durées actives en colonnes, prix en vigueur à `on`. */
  grid(scope: Scope, kindId: string, opts: { on?: string; includeArchived: boolean }, now: Date) {
    const on = opts.on ?? todayParis(now);
    return withScope(scope, async (tx) => {
      const kind = await this.kindOrThrow(tx, kindId);
      const terms = await tx.commitmentTerm.findMany({ where: { archivedAt: null }, orderBy: { months: 'asc' } });
      const items = (await tx.priceGridItem.findMany({
        where: { contractKindId: kind.id, ...(opts.includeArchived ? {} : { archivedAt: null }) },
        include: ITEM_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { number: 'asc' }],
      })) as ItemWithVariants[];
      return { on, kind: kindView(kind, items.length), terms: terms.map(termView), items: items.map((i) => itemView(i, on)) };
    });
  }

  async createItem(scope: Scope, kindId: string, body: CreateItem, now: Date) {
    const effectiveFrom = body.effectiveFrom ?? todayParis(now);
    try {
      return await withScope(scope, async (tx) => {
        const kind = await this.kindOrThrow(tx, kindId);
        if (kind.archivedAt) throw new ConflictException({ code: 'KIND_ARCHIVED', message: `Le type « ${kind.label} » est archivé.` });
        const item = await this.insertItem(tx, scope, kind.id, body, now);
        if (body.prices?.length) await this.applyPrices(tx, scope, item.id, effectiveFrom, body.prices, now);
        return itemView(await this.itemById(tx, item.id), effectiveFrom);
      });
    } catch (e) {
      translateDbError(e);
    }
  }

  updateItem(scope: Scope, code: string, body: UpdateItem, now: Date) {
    return withScope(scope, async (tx) => {
      const item = await this.itemOrThrow(tx, code);
      await tx.priceGridItem.update({
        where: { id: item.id },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.recurrence !== undefined ? { recurrence: body.recurrence } : {}),
          ...(body.vatRatePercent !== undefined ? { vatRatePercent: body.vatRatePercent } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedByUserId: actor(scope), updatedAt: now,
        },
      });
      return itemView(await this.itemById(tx, item.id), todayParis(now));
    });
  }

  /** Nouveaux prix datés (et retrait / remise en vente de durées) d'un code de base. */
  setPrices(scope: Scope, code: string, body: { effectiveFrom?: string; prices: DurationPrice[] }, now: Date) {
    const effectiveFrom = body.effectiveFrom ?? todayParis(now);
    return withScope(scope, async (tx) => {
      const item = await this.itemOrThrow(tx, code);
      if (item.archivedAt) throw new ConflictException({ code: 'ITEM_ARCHIVED', message: `Le code ${code} est archivé.` });
      await this.applyPrices(tx, scope, item.id, effectiveFrom, body.prices, now);
      return itemView(await this.itemById(tx, item.id), effectiveFrom);
    });
  }

  setItemArchived(scope: Scope, code: string, archived: boolean, now: Date) {
    return withScope(scope, async (tx) => {
      const item = await this.itemOrThrow(tx, code);
      if ((item.archivedAt !== null) !== archived) {
        await tx.priceGridItem.update({ where: { id: item.id }, data: { archivedAt: archived ? now : null, updatedByUserId: actor(scope), updatedAt: now } });
      }
      return itemView(await this.itemById(tx, item.id), todayParis(now));
    });
  }

  /** Historique complet d'un code de base : chaque version, chaque prix saisi. */
  history(scope: Scope, code: string) {
    return withScope(scope, async (tx) => {
      const item = await this.itemOrThrow(tx, code);
      const full = await this.itemById(tx, item.id);
      return {
        code: full.code, label: full.label,
        variants: full.variants
          .slice()
          .sort((a, b) => a.term.months - b.term.months)
          .map((v) => ({ code: v.code, months: v.term.months, archivedAt: v.archivedAt, prices: v.prices.map(priceView) })),
      };
    });
  }

  /**
   * Sélecteur des documents : versions actives (type, code, durée et version
   * non archivés) ayant un prix en vigueur à `on`. Filtre par type, durée et
   * texte (code ou libellé).
   */
  search(scope: Scope, q: Search, now: Date) {
    const on = q.on ?? todayParis(now);
    const text = q.q?.trim();
    return withScope(scope, async (tx) => {
      const variants = await tx.priceGridVariant.findMany({
        where: {
          archivedAt: null,
          term: { archivedAt: null, ...(q.months !== undefined ? { months: q.months } : {}) },
          item: {
            archivedAt: null,
            kind: { archivedAt: null, ...(q.kindId ? { id: q.kindId } : {}) },
            ...(text ? { OR: [{ code: { contains: text.toUpperCase() } }, { label: { contains: text, mode: 'insensitive' as const } }] } : {}),
          },
          prices: { some: { effectiveFrom: { lte: dayToDate(on) } } },
        },
        include: {
          term: true,
          item: { include: { kind: true } },
          prices: { where: { effectiveFrom: { lte: dayToDate(on) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }], take: 1 },
        },
        orderBy: [{ code: 'asc' }],
        take: q.limit ?? 50,
      });
      return { on, items: variants.map((v) => variantSnapshot(v, on)) };
    });
  }

  /** Une version par son code, prix en vigueur à `on` — ce qu'un document copie. */
  resolve(scope: Scope, code: string, on: string | undefined, now: Date) {
    const day = on ?? todayParis(now);
    return withScope(scope, async (tx) => {
      const v = await tx.priceGridVariant.findFirst({
        where: { code },
        include: {
          term: true,
          item: { include: { kind: true } },
          prices: { where: { effectiveFrom: { lte: dayToDate(day) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }], take: 1 },
        },
      });
      if (!v) throw new NotFoundException(`Code tarif ${code} introuvable`);
      if (v.archivedAt || v.item.archivedAt || v.item.kind.archivedAt || v.term.archivedAt) {
        throw new ConflictException({ code: 'VARIANT_UNAVAILABLE', message: `Le code ${code} n'est plus proposé.` });
      }
      if (!v.prices.length) throw new ConflictException({ code: 'NO_PRICE', message: `Le code ${code} n'a pas de prix en vigueur au ${day}.` });
      return variantSnapshot(v, day);
    });
  }

  /**
   * Un code de base et ses versions PROPOSÉES à `on` (prix en vigueur), lu
   * dans la transaction de l'appelant : ce qu'un document copie quand il
   * reprend une ligne de grille pour plusieurs durées (propositions).
   */
  async itemForDocument(tx: Tx, itemCode: string, on: string) {
    const item = await tx.priceGridItem.findFirst({
      where: { code: itemCode },
      include: {
        kind: true,
        variants: {
          where: { archivedAt: null, term: { archivedAt: null } },
          include: { term: true, prices: { where: { effectiveFrom: { lte: dayToDate(on) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }], take: 1 } },
        },
      },
    });
    if (!item) throw new NotFoundException(`Code tarif ${itemCode} introuvable`);
    if (item.archivedAt || item.kind.archivedAt) {
      throw new ConflictException({ code: 'VARIANT_UNAVAILABLE', message: `Le code ${itemCode} n'est plus proposé.` });
    }
    const byMonths = new Map<number, { code: string; unitPrice: string; effectiveFrom: string }>();
    for (const v of item.variants) {
      const p = v.prices[0];
      if (p) byMonths.set(v.term.months, { code: v.code, unitPrice: dec(p.unitPrice)!, effectiveFrom: isoDay(p.effectiveFrom) });
    }
    return {
      code: item.code, label: item.label, description: item.description, unit: item.unit, recurrence: item.recurrence,
      vatRatePercent: dec(item.vatRatePercent)!, kind: { id: item.kind.id, prefix: item.kind.prefix, label: item.kind.label }, byMonths,
    };
  }

  // --- CSV --------------------------------------------------------------------

  async exportCsv(scope: Scope, kindId: string, now: Date): Promise<{ filename: string; body: string }> {
    const g = await this.grid(scope, kindId, { includeArchived: false }, now);
    const months = g.terms.map((t) => t.months);
    const items: GridCsvExportItem[] = g.items.map((i) => ({
      code: i.code, label: i.label, description: i.description, unit: i.unit, recurrence: i.recurrence, vatRatePercent: i.vatRatePercent,
      prices: new Map(
        i.variants
          .filter((v) => !v.archivedAt && v.unitPrice !== null)
          .map((v) => [v.months, { unitPrice: v.unitPrice!, purchasePrice: v.purchasePrice }] as const),
      ),
    }));
    return { filename: `grille-${g.kind.prefix}-${g.on}.csv`, body: formatGridCsv(months, items) };
  }

  /**
   * Import : tout ou rien. `dryRun` calcule le même rapport puis annule la
   * transaction (aucun numéro de code consommé).
   */
  async importCsv(scope: Scope, kindId: string, file: UploadedDocument | undefined, opts: { effectiveFrom?: string; dryRun: boolean }, now: Date): Promise<ImportReport> {
    if (!file) throw new BadRequestException('Fichier CSV attendu (champ « file »).');
    const effectiveFrom = opts.effectiveFrom ?? todayParis(now);
    try {
      return await withScope(scope, async (tx) => {
        const kind = await this.kindOrThrow(tx, kindId);
        if (kind.archivedAt) throw new ConflictException({ code: 'KIND_ARCHIVED', message: `Le type « ${kind.label} » est archivé.` });
        const terms = await tx.commitmentTerm.findMany({ where: { archivedAt: null } });
        const { rows, errors } = parseGridCsv(file.buffer, new Set(terms.map((t) => t.months)), kind.prefix);
        const existing = new Map(
          (await tx.priceGridItem.findMany({ where: { contractKindId: kind.id } })).map((i) => [i.code, i] as const),
        );
        for (const r of rows) {
          if (r.code && !existing.has(r.code)) errors.push({ line: r.line, message: `Code ${r.code} inconnu pour ce type (laisser vide pour créer).` });
          else if (r.code && existing.get(r.code)!.archivedAt) errors.push({ line: r.line, message: `Code ${r.code} archivé : le désarchiver d'abord.` });
        }
        if (errors.length) {
          throw new UnprocessableEntityException({ code: 'CSV_INVALID', message: 'Fichier refusé : corriger les lignes signalées.', errors });
        }
        const report = { dryRun: opts.dryRun, effectiveFrom, created: [] as string[], updated: [] as string[], pricesAdded: 0, variantsWithdrawn: 0, errors: [] };
        for (const r of rows) {
          const fields = { label: r.label, description: r.description, unit: r.unit, recurrence: r.recurrence, vatRatePercent: r.vatRatePercent };
          let itemId: string;
          if (r.code) {
            const cur = existing.get(r.code)!;
            itemId = cur.id;
            const changed = cur.label !== r.label || cur.description !== r.description || cur.unit !== r.unit
              || cur.recurrence !== r.recurrence || !sameDecimal(dec(cur.vatRatePercent), r.vatRatePercent);
            if (changed) {
              await tx.priceGridItem.update({ where: { id: itemId }, data: { ...fields, updatedByUserId: actor(scope), updatedAt: now } });
            }
          } else {
            itemId = (await this.insertItem(tx, scope, kind.id, fields, now)).id;
          }
          const prices = [...r.prices].map(([months, p]) => ({ months, unitPrice: p.unitPrice, purchasePrice: p.purchasePrice }));
          const c = await this.applyPrices(tx, scope, itemId, effectiveFrom, prices, now);
          report.pricesAdded += c.pricesAdded;
          report.variantsWithdrawn += c.withdrawn;
          if (!r.code) report.created.push((await tx.priceGridItem.findUniqueOrThrow({ where: { id: itemId } })).code);
          else if (c.pricesAdded || c.withdrawn || c.restored) report.updated.push(r.code);
        }
        if (opts.dryRun) throw new DryRunRollback(report);
        return report;
      });
    } catch (e) {
      if (e instanceof DryRunRollback) return e.report;
      translateDbError(e);
    }
  }

  // --- interne -----------------------------------------------------------------

  private insertItem(tx: Tx, scope: Scope, kindId: string, f: Omit<CreateItem, 'prices' | 'effectiveFrom'>, now: Date) {
    // number / code : valeurs de remplissage, remplacées par le trigger.
    return tx.priceGridItem.create({
      data: {
        id: uuidv7(), tenantId: scope.tenantId, contractKindId: kindId, number: 0, code: 'ATTRIBUE-PAR-LA-BASE',
        label: f.label, description: f.description ?? null, unit: f.unit, recurrence: f.recurrence,
        vatRatePercent: f.vatRatePercent, sortOrder: f.sortOrder ?? 0,
        createdByUserId: actor(scope), updatedByUserId: actor(scope), createdAt: now, updatedAt: now,
      },
    });
  }

  private async applyPrices(tx: Tx, scope: Scope, itemId: string, effectiveFrom: string, prices: readonly DurationPrice[], now: Date) {
    const terms = new Map((await tx.commitmentTerm.findMany()).map((t) => [t.months, t] as const));
    const variants = await tx.priceGridVariant.findMany({
      where: { itemId },
      include: { prices: { orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] } },
    });
    const counts = { pricesAdded: 0, withdrawn: 0, restored: 0 };
    for (const p of prices) {
      const term = terms.get(p.months);
      if (!term) throw new UnprocessableEntityException({ code: 'UNKNOWN_TERM', message: `Aucune durée de ${p.months} mois dans le référentiel.` });
      let v = variants.find((x) => x.commitmentTermId === term.id);
      if (p.unitPrice === null) {
        if (v && !v.archivedAt) {
          await tx.priceGridVariant.update({ where: { id: v.id }, data: { archivedAt: now, updatedAt: now } });
          counts.withdrawn++;
        }
        continue;
      }
      if (term.archivedAt) throw new UnprocessableEntityException({ code: 'TERM_ARCHIVED', message: `La durée de ${p.months} mois est archivée.` });
      if (!v) {
        // code : remplissage, calculé par le trigger.
        const created = await tx.priceGridVariant.create({
          data: { id: uuidv7(), tenantId: scope.tenantId, itemId, commitmentTermId: term.id, code: 'ATTRIBUE-PAR-LA-BASE', createdByUserId: actor(scope), createdAt: now, updatedAt: now },
        });
        v = { ...created, prices: [] };
      } else if (v.archivedAt) {
        await tx.priceGridVariant.update({ where: { id: v.id }, data: { archivedAt: null, updatedAt: now } });
        counts.restored++;
      }
      const current = priceInEffect(v.prices.map(priceView), effectiveFrom);
      const purchase = p.purchasePrice ?? null;
      // Déjà le prix en vigueur à cette date : rien à écrire (import rejoué).
      if (current && sameDecimal(current.unitPrice, p.unitPrice) && sameDecimal(current.purchasePrice, purchase)) continue;
      await tx.priceGridPrice.create({
        data: {
          id: uuidv7(), tenantId: scope.tenantId, variantId: v.id, effectiveFrom: dayToDate(effectiveFrom),
          unitPrice: p.unitPrice, purchasePrice: purchase, enteredByUserId: actor(scope), createdAt: now,
        },
      });
      counts.pricesAdded++;
    }
    return counts;
  }

  private async itemById(tx: Tx, id: string) {
    return (await tx.priceGridItem.findUniqueOrThrow({ where: { id }, include: ITEM_INCLUDE })) as ItemWithVariants;
  }

  private async itemOrThrow(tx: Tx, code: string) {
    const i = await tx.priceGridItem.findFirst({ where: { code } });
    if (!i) throw new NotFoundException(`Code tarif ${code} introuvable`);
    return i;
  }

  private async kindOrThrow(tx: Tx, id: string) {
    const k = await tx.contractKind.findFirst({ where: { id } });
    if (!k) throw new NotFoundException(`Type de contrat ${id} introuvable`);
    return k;
  }
}

type SnapshotSource = Awaited<ReturnType<Tx['priceGridVariant']['findMany']>>[number] & {
  term: { months: number; label: string };
  item: Awaited<ReturnType<Tx['priceGridItem']['findMany']>>[number] & { kind: { id: string; prefix: string; label: string } };
  prices: PriceRow[];
};

/**
 * Ce qu'un document COPIE à l'ajout d'une ligne : code, libellé, prix, TVA.
 * Une modification ultérieure de la grille ne touche jamais ce qui a été copié.
 */
function variantSnapshot(v: SnapshotSource, on: string) {
  const p = v.prices[0]!;
  return {
    code: v.code, itemCode: v.item.code, months: v.term.months, termLabel: v.term.label,
    label: v.item.label, description: v.item.description, unit: v.item.unit, recurrence: v.item.recurrence,
    vatRatePercent: dec(v.item.vatRatePercent)!, unitPrice: dec(p.unitPrice)!, purchasePrice: dec(p.purchasePrice),
    effectiveFrom: isoDay(p.effectiveFrom), on,
    kind: { id: v.item.kind.id, prefix: v.item.kind.prefix, label: v.item.kind.label },
  };
}
