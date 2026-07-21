import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { NotificationsService } from './notifications.service.js';

@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.notifications.list(scope);
  }

  @Patch(':id/read')
  markRead(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(scope, id, new Date());
  }

  @Post('read-all')
  markAllRead(@CurrentScope() scope: Scope) {
    return this.notifications.markAllRead(scope, new Date());
  }
}
