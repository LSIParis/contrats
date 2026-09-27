import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ApiClientsService, CreateApiClientSchema, type CreateApiClient } from './api-clients.service.js';

/** Administration des clients de l'API publique (MSP_ADMIN). */
@Controller('v1/admin/api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'apiClients.manage');
    return this.clients.list(scope);
  }

  /** La clé (`apiKey`) n'est renvoyée qu'ici : elle n'est stockée que hachée. */
  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(CreateApiClientSchema)) body: CreateApiClient) {
    assertCan(s, 'apiClients.manage');
    return this.clients.create(scope, body, new Date());
  }

  @Post(':id/rotate')
  rotate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'apiClients.manage');
    return this.clients.rotate(scope, id, new Date());
  }

  @Post(':id/revoke')
  revoke(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'apiClients.manage');
    return this.clients.revoke(scope, id, new Date());
  }
}
