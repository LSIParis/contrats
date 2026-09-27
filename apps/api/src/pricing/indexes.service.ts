import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import type { UploadedDocument } from '../common/http-io.js';
import { INDEX_CONNECTORS, type IndexConnector, type IndexImportError } from './index-connector.js';
import { dayToDate, isoDay, todayParis, type Tx } from './pricing-snapshot.js';
import type { AddIndexValue, CreateIndex } from './pricing.schemas.js';

/**
 * Séries d'indices et valeurs publiées (04-tarification.md §6.2, §17.5).
 *
 * Aucune valeur codée en dur : tout arrive par saisie (`pricing.indexes.manage`)
 * ou par un connecteur d'import. Les deux chemins appliquent les MÊMES règles :
 *  - une période déjà publiée ne se ré-écrit pas : une valeur DIFFÉRENTE est
 *    refusée (409) — la corriger est un acte explicite (`supersedesId` +
 *    motif), qui crée une nouvelle ligne (la table est append-only) ;
 *  - une valeur IDENTIQUE à la valeur courante est ignorée (import rejouable).
 */

const MAX_CSV_BYTES = 512 * 1024;

type ValueRow = Awaited<ReturnType<Tx['priceIndexValue']['findMany']>>[number];

function valueView(v: ValueRow, current: boolean) {
  return {
    id: v.id,
    period: v.period,
    value: v.value.toFixed(),
    publishedAt: isoDay(v.publishedAt),
    source: v.source,
    revision: v.revision,
    supersedesId: v.supersedesId,
    correctionReason: v.correctionReason,
    enteredByUserId: v.enteredByUserId,
    createdAt: v.createdAt,
    current,
  };
}

function actor(scope: Scope): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.userId) ? scope.userId : null;
}

@Injectable()
export class PriceIndexesService {
  constructor(@Inject(INDEX_CONNECTORS) private readonly connectors: readonly IndexConnector[]) {}

  async list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.priceIndex.findMany({ orderBy: { code: 'asc' }, include: { values: true } });
      return {
        items: rows.map((i) => {
          const superseded = new Set(i.values.map((v) => v.supersedesId).filter(Boolean));
          const current = i.values.filter((v) => !superseded.has(v.id)).sort((a, b) => a.period.localeCompare(b.period));
          const last = current.at(-1);
          return {
            id: i.id, code: i.code, label: i.label, description: i.description, connector: i.connector,
            valuesCount: current.length,
            latest: last ? { period: last.period, value: last.value.toFixed(), publishedAt: isoDay(last.publishedAt) } : null,
          };
        }),
      };
    });
  }

  async create(scope: Scope, body: CreateIndex, now: Date) {
    try {
      return await withScope(scope, async (tx) => {
        const exists = await tx.priceIndex.findUnique({ where: { tenantId_code: { tenantId: scope.tenantId, code: body.code } }, select: { id: true } });
        if (exists) throw new ConflictException({ code: 'INDEX_EXISTS', message: `L’indice ${body.code} existe déjà.` });
        const row = await tx.priceIndex.create({
          data: {
            id: uuidv7(), tenantId: scope.tenantId, code: body.code, label: body.label,
            description: body.description ?? null, connector: body.connector ?? undefined,
            createdByUserId: actor(scope), createdAt: now, updatedAt: now,
          },
        });
        return { id: row.id, code: row.code, label: row.label, description: row.description, connector: row.connector };
      });
    } catch (e) {
      // Création concurrente : la transaction est annulée, on le dit hors transaction.
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'INDEX_EXISTS', message: `L’indice ${body.code} existe déjà.` });
      throw e;
    }
  }

  async values(scope: Scope, code: string) {
    return withScope(scope, async (tx) => {
      const index = await this.indexOrThrow(tx, code);
      const rows = await tx.priceIndexValue.findMany({ where: { indexId: index.id }, orderBy: [{ period: 'asc' }, { revision: 'asc' }] });
      const superseded = new Set(rows.map((v) => v.supersedesId).filter(Boolean));
      return { code: index.code, label: index.label, items: rows.map((v) => valueView(v, !superseded.has(v.id))) };
    });
  }

  async addValue(scope: Scope, code: string, body: AddIndexValue, now: Date) {
    const row = await this.write(scope, code, async (tx, index) => {
      const chain = await tx.priceIndexValue.findMany({ where: { indexId: index.id, period: body.period }, orderBy: { revision: 'asc' } });
      const tip = tipOf(chain);
      if (body.supersedesId) {
        const target = chain.find((v) => v.id === body.supersedesId);
        if (!target) throw new NotFoundException(`Valeur ${body.supersedesId} introuvable pour ${code} ${body.period}.`);
        if (tip && tip.id !== target.id) {
          throw new ConflictException({ code: 'NOT_CURRENT_VALUE', message: 'Seule la valeur courante d’une période peut être corrigée.', currentId: tip.id });
        }
        return tx.priceIndexValue.create({
          data: {
            id: uuidv7(), tenantId: index.tenantId, indexId: index.id, period: body.period, value: body.value,
            publishedAt: dayToDate(body.publishedAt), source: 'MANUAL', revision: target.revision + 1,
            supersedesId: target.id, correctionReason: body.correctionReason ?? null, enteredByUserId: actor(scope), createdAt: now,
          },
        });
      }
      if (tip) {
        throw new ConflictException({
          code: 'PERIOD_ALREADY_PUBLISHED',
          message: `${code} ${body.period} est déjà publié (${tip.value.toFixed()}) : une correction passe par supersedesId + motif.`,
          currentId: tip.id,
        });
      }
      return tx.priceIndexValue.create({
        data: {
          id: uuidv7(), tenantId: index.tenantId, indexId: index.id, period: body.period, value: body.value,
          publishedAt: dayToDate(body.publishedAt), source: 'MANUAL', revision: 0, enteredByUserId: actor(scope), createdAt: now,
        },
      });
    });
    return valueView(row, true);
  }

  /**
   * Import par connecteur (CSV par défaut, ou celui de `price_indexes.connector`).
   *
   * TOUT OU RIEN : la moindre ligne invalide (format, doublon dans le
   * fichier, valeur contredisant une période déjà publiée) refuse le fichier
   * entier (422, erreurs numérotées), rien n'est écrit. Les lignes
   * identiques à l'existant sont ignorées. Date de publication absente de la
   * source : date du jour de l'import (V2-H25).
   */
  async importFile(scope: Scope, code: string, file: UploadedDocument | undefined, now: Date) {
    if (!file) throw new BadRequestException('Fichier manquant (champ « file »).');
    if (file.size > MAX_CSV_BYTES) throw new BadRequestException(`Fichier trop volumineux (${MAX_CSV_BYTES} octets max).`);
    const today = todayParis(now);
    return this.write(scope, code, async (tx, index) => {
      const config = (index.connector ?? null) as Record<string, unknown> | null;
      const type = typeof config?.type === 'string' ? config.type : 'CSV';
      const connector = this.connectors.find((c) => c.type === type);
      if (!connector) throw new UnprocessableEntityException({ code: 'UNKNOWN_CONNECTOR', message: `Connecteur « ${type} » non disponible.` });

      const parsed = connector.parse(file.buffer, config);
      const errors: IndexImportError[] = [...parsed.errors];
      const existing = await tx.priceIndexValue.findMany({ where: { indexId: index.id } });
      const tips = new Map<string, ValueRow>();
      for (const [period, chain] of groupBy(existing, (v) => v.period)) {
        const t = tipOf(chain);
        if (t) tips.set(period, t);
      }
      const toCreate: typeof parsed.rows = [];
      let unchanged = 0;
      for (const r of parsed.rows) {
        const tip = tips.get(r.period);
        if (!tip) toCreate.push(r);
        else if (tip.value.equals(r.value)) unchanged++;
        else {
          errors.push({
            line: r.line,
            message: `${r.period} déjà publié avec une autre valeur (${tip.value.toFixed()}) : corriger explicitement (supersedesId + motif).`,
          });
        }
      }
      if (errors.length || (parsed.rows.length === 0 && parsed.errors.length === 0)) {
        throw new UnprocessableEntityException({
          code: 'INVALID_IMPORT',
          message: errors.length ? `${errors.length} ligne(s) invalide(s) : aucune valeur importée.` : 'Fichier vide.',
          errors: errors.sort((a, b) => a.line - b.line),
        });
      }
      if (toCreate.length) {
        // Aucun conflit possible ici (périodes vérifiées sous la même
        // transaction) ; une création concurrente ferait échouer la
        // transaction ENTIÈRE, sans import partiel.
        await tx.priceIndexValue.createMany({
          data: toCreate.map((r) => ({
            id: uuidv7(), tenantId: index.tenantId, indexId: index.id, period: r.period, value: r.value,
            publishedAt: dayToDate(r.publishedAt ?? today), source: 'IMPORT' as const, revision: 0,
            enteredByUserId: actor(scope), createdAt: now,
          })),
        });
      }
      return { code: index.code, connector: type, imported: toCreate.length, unchanged, periods: toCreate.map((r) => r.period) };
    });
  }

  private async write<T>(scope: Scope, code: string, fn: (tx: Tx, index: { id: string; tenantId: string; code: string; connector: unknown }) => Promise<T>): Promise<T> {
    try {
      return await withScope(scope, async (tx) => fn(tx, await this.indexOrThrow(tx, code)));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException({ code: 'CONCURRENT_WRITE', message: 'Valeur publiée entre-temps pour cette période : recharger.' });
      }
      throw e;
    }
  }

  private async indexOrThrow(tx: Tx, code: string) {
    const index = await tx.priceIndex.findFirst({ where: { code } });
    if (!index) throw new NotFoundException(`Indice ${code} introuvable`);
    return index;
  }
}

function tipOf<T extends { id: string; supersedesId: string | null }>(chain: readonly T[]): T | undefined {
  const superseded = new Set(chain.map((v) => v.supersedesId).filter(Boolean));
  return chain.find((v) => !superseded.has(v.id));
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}
