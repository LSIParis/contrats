import { Controller, Get, Query } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { RemindersReadService } from './reminders.service.js';
import { ListRemindersDto } from './dto/list-reminders.dto.js';

/**
 * Source de données de l'écran rappels et du widget cockpit.
 *
 * Scopé par le guard global : pas de @Public(). Les rappels sont filtrés
 * entièrement sous withScope dans le service — jamais de requête globale.
 */
@Controller('v1/reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersReadService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @Query() query: ListRemindersDto) {
    return this.reminders.list(scope, query.status);
  }
}
