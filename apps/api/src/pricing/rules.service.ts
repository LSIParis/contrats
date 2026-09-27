import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { RuleDefinitionSchemas, type CreateRule, type RuleType, type UpdateRule } from './pricing.schemas.js';
import type { Tx } from './pricing-snapshot.js';

/**
 * Catalogue de règles du tenant (brief §5 mode 1 ; 04 §4.2, §17.6) —
 * `pricing.rules.manage` (admin).
 *
 * `definition` est validée contre le schéma du TYPE de règle (mêmes champs que
 * `PricingRule` du moteur, sans id/type/label portés par les colonnes). Le
 * type ne change pas après création : une grille ne devient pas une remise.
 *
 * Pas de suppression (DELETE révoqué en base) : une règle citée par un barème
 * engagé doit rester résoluble. On l'ARCHIVE — elle n'est plus proposée
 * (liste par défaut, devis catalogue) mais le calcul des barèmes qui la citent
 * continue. Rejouabilité (V2-H27) : le catalogue est l'état COURANT ; modifier
 * une grille modifie le prix des lignes RULE qui la citent, à toute date. Pour
 * figer un prix contractuel, la ligne passe en MANUAL (ou la grille change de
 * code à chaque millésime : « grille-2026 », « grille-2027 »).
 */

type RuleRow = Awaited<ReturnType<Tx['pricingRule']['findMany']>>[number];

function view(r: RuleRow) {
  return {
    id: r.id, code: r.code, type: r.type, label: r.label, definition: r.definition,
    archivedAt: r.archivedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function checkDefinition(type: RuleType, definition: unknown): Record<string, unknown> {
  const r = RuleDefinitionSchemas[type].safeParse(definition);
  if (!r.success) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: r.error.issues.map((i) => `definition${i.path.length ? '.' + i.path.join('.') : ''} : ${i.message}`),
    });
  }
  return r.data as Record<string, unknown>;
}

function actor(scope: Scope): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.userId) ? scope.userId : null;
}

@Injectable()
export class PricingRulesService {
  list(scope: Scope, includeArchived: boolean) {
    return withScope(scope, async (tx) => ({
      items: (await tx.pricingRule.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { code: 'asc' } })).map(view),
    }));
  }

  async create(scope: Scope, body: CreateRule, now: Date) {
    const definition = checkDefinition(body.type, body.definition);
    try {
      return await withScope(scope, async (tx) => {
        const exists = await tx.pricingRule.findUnique({ where: { tenantId_code: { tenantId: scope.tenantId, code: body.code } }, select: { id: true } });
        if (exists) throw new ConflictException({ code: 'RULE_EXISTS', message: `La règle ${body.code} existe déjà.` });
        return view(
          await tx.pricingRule.create({
            data: {
              id: uuidv7(), tenantId: scope.tenantId, code: body.code, type: body.type, label: body.label,
              definition: definition as never, createdByUserId: actor(scope), updatedByUserId: actor(scope), createdAt: now, updatedAt: now,
            },
          }),
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'RULE_EXISTS', message: `La règle ${body.code} existe déjà.` });
      throw e;
    }
  }

  update(scope: Scope, code: string, body: UpdateRule, now: Date) {
    return withScope(scope, async (tx) => {
      const r = await this.ruleOrThrow(tx, code);
      const definition = body.definition === undefined ? undefined : checkDefinition(r.type, body.definition);
      return view(
        await tx.pricingRule.update({
          where: { id: r.id },
          data: {
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(definition !== undefined ? { definition: definition as never } : {}),
            updatedByUserId: actor(scope), updatedAt: now,
          },
        }),
      );
    });
  }

  archive(scope: Scope, code: string, now: Date) {
    return withScope(scope, async (tx) => {
      const r = await this.ruleOrThrow(tx, code);
      if (r.archivedAt) return view(r);
      return view(await tx.pricingRule.update({ where: { id: r.id }, data: { archivedAt: now, updatedByUserId: actor(scope), updatedAt: now } }));
    });
  }

  private async ruleOrThrow(tx: Tx, code: string) {
    const r = await tx.pricingRule.findFirst({ where: { code } });
    if (!r) throw new NotFoundException(`Règle ${code} introuvable`);
    return r;
  }
}
