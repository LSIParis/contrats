import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { SignatureActionsService } from './signature-actions.service.js';

@Controller('v1/contracts')
export class SignatureActionsController {
  constructor(private readonly actions: SignatureActionsService) {}

  @Post(':id/signature/remind')
  remind(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.actions.remind(scope, id);
  }
}
