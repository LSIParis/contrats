import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { PortalService } from './portal.service.js';

@Controller('v1/portal')
export class PortalContractsController {
  constructor(private readonly portal: PortalService) {}

  @Get('contracts')
  list(@CurrentScope() scope: Scope) {
    return this.portal.list(scope);
  }

  @Get('contracts/:id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.findOne(scope, id);
  }

  @Get('me')
  async me(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    // L'email vient de la session ; à défaut, on le lit depuis l'utilisateur.
    const email = (session as any).email ?? (await this.portal.emailOf(scope, session.userId));
    return this.portal.me(scope, email);
  }
}
