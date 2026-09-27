import { Controller, Get, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { AuditReadService } from './audit-read.service.js';
import { ListAuditDto } from './dto/list-audit.dto.js';

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditReadService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Query() q: ListAuditDto) {
    assertCan(session, 'audit.read');
    return this.audit.list(scope, q);
  }

  @Get('verify')
  verify(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'audit.read');
    return this.audit.verify(scope);
  }
}
