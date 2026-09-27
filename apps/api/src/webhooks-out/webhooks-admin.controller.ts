import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  CreateWebhookBody, ListDeliveriesQuery,
  type CreateWebhookInput, type ListDeliveriesInput,
} from './webhooks-admin.dto.js';
import { WebhooksAdminService } from './webhooks-admin.service.js';

/**
 * Administration des webhooks sortants (MSP_ADMIN, permission
 * `webhooks.manage`). Détail : docs/contrats/07-api.md §Webhooks sortants.
 */
@Controller('v1/admin')
export class WebhooksAdminController {
  constructor(private readonly webhooks: WebhooksAdminService) {}

  @Get('webhooks')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'webhooks.manage');
    return { subscriptions: await this.webhooks.list(scope), eventTypes: this.webhooks.eventTypes() };
  }

  /** Le secret figure dans CETTE réponse, et plus jamais ensuite. */
  @Post('webhooks')
  create(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Body(new ZodPipe(CreateWebhookBody)) body: CreateWebhookInput,
  ) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.create(scope, body, new Date());
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  rotate(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.rotateSecret(scope, id, new Date());
  }

  @Post('webhooks/:id/disable')
  @HttpCode(200)
  disable(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.setActive(scope, id, false, new Date());
  }

  @Post('webhooks/:id/enable')
  @HttpCode(200)
  enable(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.setActive(scope, id, true, new Date());
  }

  @Get('webhooks/:id/deliveries')
  async deliveries(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(ListDeliveriesQuery)) q: ListDeliveriesInput,
  ) {
    assertCan(session, 'webhooks.manage');
    return { deliveries: await this.webhooks.deliveries(scope, id, q) };
  }

  @Post('webhooks/:id/test')
  @HttpCode(200)
  test(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.test(scope, id, new Date());
  }

  @Post('webhook-deliveries/:id/redeliver')
  @HttpCode(200)
  redeliver(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'webhooks.manage');
    return this.webhooks.redeliver(scope, id, new Date());
  }
}
