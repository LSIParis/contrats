import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan, assertCanAny, type Action } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { readMultipart } from '../common/http-io.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { IsoDate } from '../pricing/pricing.schemas.js';
import {
  CreateItemSchema,
  CreateKindSchema,
  CreateTermSchema,
  GridQuery,
  ImportFields,
  ItemCode,
  ListQuery,
  Months,
  SearchQuery,
  SetPricesSchema,
  UpdateItemSchema,
  UpdateKindSchema,
  UpdateTermSchema,
  VariantCode,
  type CreateItem,
  type CreateKind,
  type CreateTerm,
  type Search,
  type SetPrices,
  type UpdateItem,
  type UpdateKind,
  type UpdateTerm,
} from './contract-kinds.schemas.js';
import { ContractKindsService } from './contract-kinds.service.js';
import { PriceGridService } from './price-grid.service.js';

const IdParam = new ZodPipe(z.uuid());
const ItemParam = new ZodPipe(ItemCode);
const VariantParam = new ZodPipe(VariantCode);
const MonthsParam = new ZodPipe(Months);
const OnQuery = new ZodPipe(z.object({ on: IsoDate.optional() }).strict());

/** Lecture : toute personne qui rédige ou consulte contrats et propositions. */
const READ: readonly Action[] = ['contracts.read', 'proposals.read'];

/**
 * Types de contrats, durées d'engagement et grilles tarifaires
 * (docs/contrats/13-types-contrats.md). Écriture : `pricing.grid.manage`.
 * Le tenant vient TOUJOURS de la session : aucun paramètre `tenantId`.
 */
@Controller('v1')
export class ContractKindsController {
  constructor(
    private readonly kinds: ContractKindsService,
    private readonly grid: PriceGridService,
  ) {}

  // --- Types de contrats ------------------------------------------------------

  @Get('contract-kinds')
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    assertCanAny(s, READ);
    return this.kinds.list(scope, q.archived === 'true');
  }

  @Post('contract-kinds')
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(CreateKindSchema)) body: CreateKind) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.create(scope, body, new Date());
  }

  @Get('contract-kinds/:id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string) {
    assertCanAny(s, READ);
    return this.kinds.get(scope, id);
  }

  @Put('contract-kinds/:id')
  update(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string, @Body(new ZodPipe(UpdateKindSchema)) body: UpdateKind) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.update(scope, id, body, new Date());
  }

  @Post('contract-kinds/:id/archive')
  archive(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.setArchived(scope, id, true, new Date());
  }

  @Post('contract-kinds/:id/unarchive')
  unarchive(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.setArchived(scope, id, false, new Date());
  }

  @Delete('contract-kinds/:id')
  remove(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.remove(scope, id);
  }

  // --- Grille d'un type ---------------------------------------------------------

  @Get('contract-kinds/:id/grid')
  getGrid(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string, @Query(new ZodPipe(GridQuery)) q: z.infer<typeof GridQuery>) {
    assertCanAny(s, READ);
    return this.grid.grid(scope, id, { on: q.on, includeArchived: q.archived === 'true' }, new Date());
  }

  @Post('contract-kinds/:id/grid/items')
  createItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string, @Body(new ZodPipe(CreateItemSchema)) body: CreateItem) {
    assertCan(s, 'pricing.grid.manage');
    return this.grid.createItem(scope, id, body, new Date());
  }

  @Get('contract-kinds/:id/grid.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async exportCsv(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    assertCanAny(s, READ);
    const { filename, body } = await this.grid.exportCsv(scope, id, new Date());
    res.header('content-disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** Multipart : `file` (CSV), `effectiveFrom` (date d'effet des prix), `dryRun` (« true » = aperçu). */
  @Post('contract-kinds/:id/grid/import')
  async importCsv(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', IdParam) id: string, @Req() req: FastifyRequest) {
    assertCan(s, 'pricing.grid.manage');
    const { file, fields } = await readMultipart(req, 'file');
    const f = new ZodPipe(ImportFields).transform(fields) as z.infer<typeof ImportFields>;
    return this.grid.importCsv(scope, id, file, { effectiveFrom: f.effectiveFrom, dryRun: f.dryRun === 'true' }, new Date());
  }

  // --- Codes de base ------------------------------------------------------------

  @Put('price-grid/items/:code')
  updateItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', ItemParam) code: string, @Body(new ZodPipe(UpdateItemSchema)) body: UpdateItem) {
    assertCan(s, 'pricing.grid.manage');
    return this.grid.updateItem(scope, code, body, new Date());
  }

  @Post('price-grid/items/:code/prices')
  setPrices(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', ItemParam) code: string, @Body(new ZodPipe(SetPricesSchema)) body: SetPrices) {
    assertCan(s, 'pricing.grid.manage');
    return this.grid.setPrices(scope, code, body, new Date());
  }

  @Post('price-grid/items/:code/archive')
  archiveItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', ItemParam) code: string) {
    assertCan(s, 'pricing.grid.manage');
    return this.grid.setItemArchived(scope, code, true, new Date());
  }

  @Post('price-grid/items/:code/unarchive')
  unarchiveItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', ItemParam) code: string) {
    assertCan(s, 'pricing.grid.manage');
    return this.grid.setItemArchived(scope, code, false, new Date());
  }

  @Get('price-grid/items/:code/history')
  history(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', ItemParam) code: string) {
    assertCanAny(s, READ);
    return this.grid.history(scope, code);
  }

  // --- Sélecteur des documents ----------------------------------------------------

  @Get('price-grid/variants')
  search(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(SearchQuery)) q: Search) {
    assertCanAny(s, READ);
    return this.grid.search(scope, q, new Date());
  }

  @Get('price-grid/variants/:code')
  resolve(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('code', VariantParam) code: string, @Query(OnQuery) q: { on?: string }) {
    assertCanAny(s, READ);
    return this.grid.resolve(scope, code, q.on, new Date());
  }

  // --- Durées d'engagement --------------------------------------------------------

  @Get('commitment-terms')
  listTerms(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    assertCanAny(s, READ);
    return this.kinds.listTerms(scope, q.archived === 'true');
  }

  @Post('commitment-terms')
  createTerm(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(CreateTermSchema)) body: CreateTerm) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.createTerm(scope, body, new Date());
  }

  @Put('commitment-terms/:months')
  updateTerm(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('months', MonthsParam) months: number, @Body(new ZodPipe(UpdateTermSchema)) body: UpdateTerm) {
    assertCan(s, 'pricing.grid.manage');
    return this.kinds.updateTerm(scope, months, body, new Date());
  }
}
