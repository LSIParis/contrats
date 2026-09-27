import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { z } from 'zod';
import type { Scope } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { PricingService } from '../pricing/pricing.service.js';
import type { QuoteBody } from '../pricing/pricing.schemas.js';
import { todayParis } from '../pricing/pricing-snapshot.js';
import { WebhooksAdminService } from '../webhooks-out/webhooks-admin.service.js';
import type { CreateWebhookInput } from '../webhooks-out/webhooks-admin.dto.js';
import { ApiClientGuard, RequireScopes } from './api-client.guard.js';
import { EtagInterceptor } from './etag.interceptor.js';
import { ProblemFilter } from './problem.filter.js';
import { PublicReadService } from './public-read.service.js';
import { PublicProposalsService } from './public-proposals.service.js';
import { ProposalsService } from '../proposals/proposals.service.js';
import { ClientContractsQuery, CreateWebhookBody, DeadlinesQuery, PricingAtQuery, ProposalsQuery, QuoteSchema } from './schemas.js';

/**
 * API publique de la suite — `/api/v1` (brief §8, 07-api.md).
 *
 * @Public() pour le guard global de SESSION : l'authentification est celle
 * du client d'API (ApiClientGuard, clé hachée + scopes + débit + drapeau).
 * Toute route ajoutée ici hérite du guard, du format d'erreur RFC 9457 et
 * de l'ETag — et DOIT être décrite dans `openapi.ts` (test de cohérence).
 */
@Public()
@Controller('api/v1')
@UseGuards(ApiClientGuard)
@UseFilters(ProblemFilter)
@UseInterceptors(EtagInterceptor)
export class PublicApiController {
  constructor(
    private readonly read: PublicReadService,
    private readonly pricing: PricingService,
    private readonly webhooks: WebhooksAdminService,
    private readonly proposals: PublicProposalsService,
    private readonly proposalModule: ProposalsService,
  ) {}

  @Get('clients/:clientRef/contracts')
  @RequireScopes('contracts:read')
  clientContracts(
    @CurrentScope() scope: Scope, @Param('clientRef') clientRef: string,
    @Query(new ZodPipe(ClientContractsQuery)) q: z.infer<typeof ClientContractsQuery>,
  ) {
    return this.read.clientContracts(scope, clientRef.slice(0, 100), q);
  }

  @Get('contracts/:id')
  @RequireScopes('contracts:read')
  contract(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.read.contract(scope, id);
  }

  @Get('contracts/:id/dates')
  @RequireScopes('contracts:dates:read')
  dates(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.read.dates(scope, id, new Date());
  }

  @Get('contracts/:id/pricing')
  @RequireScopes('pricing:read')
  contractPricing(
    @CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(PricingAtQuery)) q: z.infer<typeof PricingAtQuery>,
  ) {
    return this.pricing.priceAt(scope, id, q.at ?? todayParis(), { trace: q.trace === 'true' });
  }

  @Post('pricing/quote')
  @HttpCode(200)
  @RequireScopes('pricing:quote')
  quote(@CurrentScope() scope: Scope, @Body(new ZodPipe(QuoteSchema)) body: QuoteBody) {
    return this.pricing.quote(scope, body);
  }

  @Get('deadlines')
  @RequireScopes('contracts:dates:read')
  deadlines(@CurrentScope() scope: Scope, @Query(new ZodPipe(DeadlinesQuery)) q: z.infer<typeof DeadlinesQuery>) {
    return this.read.deadlines(scope, q, new Date());
  }

  // --- Propositions (lot 9.8) — module désactivé = 404 ------------------------

  @Get('proposals')
  @RequireScopes('proposals:read')
  async listProposals(@CurrentScope() scope: Scope, @Query(new ZodPipe(ProposalsQuery)) q: z.infer<typeof ProposalsQuery>) {
    await this.proposalModule.assertEnabled(scope);
    return this.proposals.list(scope, q);
  }

  @Get('clients/:clientRef/proposals')
  @RequireScopes('proposals:read')
  async clientProposals(
    @CurrentScope() scope: Scope, @Param('clientRef') clientRef: string,
    @Query(new ZodPipe(ProposalsQuery)) q: z.infer<typeof ProposalsQuery>,
  ) {
    await this.proposalModule.assertEnabled(scope);
    return this.proposals.list(scope, q, clientRef.slice(0, 100));
  }

  @Get('proposals/:id')
  @RequireScopes('proposals:read')
  async proposal(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    await this.proposalModule.assertEnabled(scope);
    return this.proposals.get(scope, id);
  }

  @Get('proposals/:id/pricing')
  @RequireScopes('proposals:pricing:read')
  async proposalPricing(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    await this.proposalModule.assertEnabled(scope);
    return this.proposals.pricing(scope, id);
  }

  // --- Webhooks sortants (scope webhooks:manage) ----------------------------

  @Get('webhooks')
  @RequireScopes('webhooks:manage')
  listWebhooks(@CurrentScope() scope: Scope) {
    return this.webhooks.list(scope).then((data) => ({ data, eventTypes: this.webhooks.eventTypes() }));
  }

  /** Le secret HMAC n'est renvoyé qu'ici, une seule fois. */
  @Post('webhooks')
  @RequireScopes('webhooks:manage')
  createWebhook(@CurrentScope() scope: Scope, @Body(new ZodPipe(CreateWebhookBody)) body: CreateWebhookInput) {
    return this.webhooks.create(scope, body, new Date());
  }

  @Delete('webhooks/:id')
  @RequireScopes('webhooks:manage')
  disableWebhook(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.setActive(scope, id, false, new Date());
  }
}
