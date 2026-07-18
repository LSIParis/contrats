import { Controller, Get } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from './current-scope.decorator.js';
import type { Session } from './session.service.js';

@Controller('v1/auth')
export class MeController {
  @Get('me')
  async me(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    const user = await withScope(scope, (tx) =>
      tx.user.findFirst({
        where: { id: session.userId },
        select: { fullName: true, email: true, kind: true, customerId: true },
      }),
    );
    return {
      userId: session.userId,
      tenantId: session.tenantId,
      roles: session.roles,
      fullName: user?.fullName ?? null,
      email: user?.email ?? null,
      kind: user?.kind ?? null,
      customerId: user?.customerId ?? null,
    };
  }
}
