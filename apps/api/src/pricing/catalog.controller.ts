import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { readMultipart } from '../common/http-io.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { PriceIndexesService } from './indexes.service.js';
import {
  AddIndexValueSchema,
  CreateIndexSchema,
  CreateRuleSchema,
  IndexCode,
  RuleCode,
  UpdateRuleSchema,
  type AddIndexValue,
  type CreateIndex,
  type CreateRule,
  type UpdateRule,
} from './pricing.schemas.js';
import { PricingRulesService } from './rules.service.js';

const CodeParam = new ZodPipe(IndexCode);
const RuleParam = new ZodPipe(RuleCode);
const ListRules = z.object({ archived: z.enum(['true', 'false']).optional() }).strict();

/**
 * Référentiels de tarification du tenant (04-tarification.md §17.5–17.6) :
 * indices (`pricing.indexes.manage` pour écrire) et catalogue de règles
 * (`pricing.rules.manage`). Lecture : toute session interne (`contracts.read`).
 * Le tenant vient TOUJOURS de la session : aucun paramètre `tenantId`.
 */
@Controller('v1')
export class PricingCatalogController {
  constructor(
    private readonly indexes: PriceIndexesService,
    private readonly rules: PricingRulesService,
  ) {}

  // --- Indices -----------------------------------------------------------------

  @Get('price-indexes')
  listIndexes(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'contracts.read');
    return this.indexes.list(scope);
  }

  @Post('price-indexes')
  createIndex(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Body(new ZodPipe(CreateIndexSchema)) body: CreateIndex) {
    assertCan(session, 'pricing.indexes.manage');
    return this.indexes.create(scope, body, new Date());
  }

  @Get('price-indexes/:code/values')
  values(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('code', CodeParam) code: string) {
    assertCan(session, 'contracts.read');
    return this.indexes.values(scope, code);
  }

  /** Saisie manuelle d'une valeur, ou correction (`supersedesId` + motif). */
  @Post('price-indexes/:code/values')
  addValue(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('code', CodeParam) code: string,
    @Body(new ZodPipe(AddIndexValueSchema)) body: AddIndexValue,
  ) {
    assertCan(session, 'pricing.indexes.manage');
    return this.indexes.addValue(scope, code, body, new Date());
  }

  /** Import par connecteur : multipart, champ `file` (CSV `period;value[;publishedAt]`). */
  @Post('price-indexes/:code/values/import')
  async importValues(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('code', CodeParam) code: string,
    @Req() req: FastifyRequest,
  ) {
    assertCan(session, 'pricing.indexes.manage');
    const { file, fields } = await readMultipart(req, 'file');
    new ZodPipe(z.object({}).strict()).transform(fields);
    return this.indexes.importFile(scope, code, file, new Date());
  }

  // --- Catalogue de règles -------------------------------------------------------

  @Get('pricing-rules')
  listRules(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Query(new ZodPipe(ListRules)) q: z.infer<typeof ListRules>) {
    assertCan(session, 'contracts.read');
    return this.rules.list(scope, q.archived === 'true');
  }

  @Post('pricing-rules')
  createRule(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Body(new ZodPipe(CreateRuleSchema)) body: CreateRule) {
    assertCan(session, 'pricing.rules.manage');
    return this.rules.create(scope, body, new Date());
  }

  @Put('pricing-rules/:code')
  updateRule(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('code', RuleParam) code: string,
    @Body(new ZodPipe(UpdateRuleSchema)) body: UpdateRule,
  ) {
    assertCan(session, 'pricing.rules.manage');
    return this.rules.update(scope, code, body, new Date());
  }

  @Post('pricing-rules/:code/archive')
  archiveRule(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('code', RuleParam) code: string) {
    assertCan(session, 'pricing.rules.manage');
    return this.rules.archive(scope, code, new Date());
  }
}
