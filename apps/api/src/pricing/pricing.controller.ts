import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { PriceOverridesService } from './overrides.service.js';
import { todayParis } from './pricing-snapshot.js';
import {
  CreateOverrideSchema,
  CreateScheduleSchema,
  PricingQuerySchema,
  QuoteSchema,
  RejectSchema,
  SimulateSchema,
  UpdateScheduleSchema,
  type CreateOverride,
  type CreateSchedule,
  type PricingQuery,
  type QuoteBody,
  type SimulateBody,
  type UpdateSchedule,
} from './pricing.schemas.js';
import { PricingService } from './pricing.service.js';
import { PricingSchedulesService } from './schedules.service.js';

// Le ValidationPipe global (transform) convertit déjà un paramètre typé `number` :
// on accepte les deux formes, et on revalide.
const VersionParam = new ZodPipe(
  z.union([z.number(), z.string().regex(/^\d{1,6}$/, 'numéro de version attendu').transform(Number)]).pipe(z.number().int().min(1).max(999999)),
);

/**
 * API interne de tarification d'un contrat (04-tarification.md §17.7).
 *
 * Droits (auth/permissions.ts) : lecture = `contracts.read` ; écriture du
 * barème et des dérogations = `pricing.write` ; simulateur et devis =
 * `pricing.simulate` ; seconde validation = `pricing.override.approve`. Le
 * « sur quoi » reste la RLS : un contrat hors portefeuille répond 404.
 *
 * Montants : prix en chaînes décimales (euros), totaux en chaînes d'entiers
 * (centimes) — jamais de nombre JSON pour de la monnaie.
 */
@Controller('v1')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly schedules: PricingSchedulesService,
    private readonly overrides: PriceOverridesService,
  ) {}

  // --- Barème versionné ------------------------------------------------------

  @Get('contracts/:id/pricing/schedules')
  listSchedules(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'contracts.read');
    return this.schedules.list(scope, id, new Date());
  }

  /** Nouvelle version (brouillon). */
  @Post('contracts/:id/pricing/schedules')
  createSchedule(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CreateScheduleSchema)) body: CreateSchedule,
  ) {
    assertCan(session, 'pricing.write');
    return this.schedules.createDraft(scope, id, body, new Date());
  }

  /** Remplacement d'un BROUILLON (409 sur une version engagée). */
  @Put('contracts/:id/pricing/schedules/:version')
  updateSchedule(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', VersionParam) version: number,
    @Body(new ZodPipe(UpdateScheduleSchema)) body: UpdateSchedule,
  ) {
    assertCan(session, 'pricing.write');
    return this.schedules.updateDraft(scope, id, version, body, new Date());
  }

  @Delete('contracts/:id/pricing/schedules/:version')
  deleteSchedule(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', VersionParam) version: number,
  ) {
    assertCan(session, 'pricing.write');
    return this.schedules.deleteDraft(scope, id, version);
  }

  @Post('contracts/:id/pricing/schedules/:version/activate')
  activate(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', VersionParam) version: number,
  ) {
    assertCan(session, 'pricing.write');
    return this.schedules.activate(scope, id, version, new Date());
  }

  // --- priceAt / simulateur ---------------------------------------------------

  /** Barème à la date (`at`, défaut : aujourd'hui à Paris), trace sur demande. */
  @Get('contracts/:id/pricing')
  priceAt(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(PricingQuerySchema)) q: PricingQuery,
  ) {
    assertCan(session, 'contracts.read');
    return this.pricing.priceAt(scope, id, q.at ?? todayParis(), {
      trace: q.trace ?? false,
      ...(q.version !== undefined ? { version: q.version } : {}),
    });
  }

  @Post('contracts/:id/pricing/simulate')
  @HttpCode(200)
  simulate(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SimulateSchema)) body: SimulateBody,
  ) {
    assertCan(session, 'pricing.simulate');
    return this.pricing.simulate(scope, id, body);
  }

  /** Devis interne ; le futur `POST /api/v1/pricing/quote` appellera le même service. */
  @Post('pricing/quote')
  @HttpCode(200)
  quote(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Body(new ZodPipe(QuoteSchema)) body: QuoteBody) {
    assertCan(session, 'pricing.simulate');
    return this.pricing.quote(scope, body);
  }

  // --- Dérogations -------------------------------------------------------------

  @Get('contracts/:id/pricing/overrides')
  listOverrides(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'contracts.read');
    return this.overrides.list(scope, id);
  }

  @Post('contracts/:id/pricing/overrides')
  createOverride(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CreateOverrideSchema)) body: CreateOverride,
  ) {
    assertCan(session, 'pricing.write');
    return this.overrides.create(scope, id, body, new Date());
  }

  @Post('contracts/:id/pricing/overrides/:overrideId/approve')
  approve(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
  ) {
    assertCan(session, 'pricing.override.approve');
    return this.overrides.approve(scope, id, overrideId, new Date());
  }

  @Post('contracts/:id/pricing/overrides/:overrideId/reject')
  reject(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @Body(new ZodPipe(RejectSchema)) body: z.infer<typeof RejectSchema>,
  ) {
    assertCan(session, 'pricing.override.approve');
    return this.overrides.reject(scope, id, overrideId, body.reason, new Date());
  }

  @Post('contracts/:id/pricing/overrides/:overrideId/cancel')
  cancel(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
  ) {
    assertCan(session, 'pricing.write');
    return this.overrides.cancel(scope, id, overrideId, new Date());
  }
}
