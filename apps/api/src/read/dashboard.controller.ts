import { Controller, Get } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Source de données de l'écran cockpit d'adoption (§6.1).
 *
 * Scopé par le guard global : pas de @Public(). Les agrégats sont calculés
 * entièrement sous withScope dans le service — jamais de requête globale.
 */
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  build(@CurrentScope() scope: Scope) {
    return this.dashboard.build(scope, new Date());
  }
}
