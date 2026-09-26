import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { DeadlinesService } from './deadlines.service.js';

const Range = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .strict()
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: 'from doit précéder to', path: ['to'] });

/** Échéancier (API interne). L'API publique l'expose sous /api/v1/deadlines (07-api.md). */
@Controller('v1')
export class DeadlinesController {
  constructor(private readonly deadlines: DeadlinesService) {}

  /** Échéances ouvertes, tous contrats du portefeuille. Défaut : les 120 prochains jours. */
  @Get('deadlines')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Query(new ZodPipe(Range)) q: z.infer<typeof Range>) {
    assertCan(session, 'contracts.read');
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 120 * 86_400_000);
    return { items: await this.deadlines.list(scope, from, to) };
  }

  /**
   * Recalcul immédiat de l'échéancier du tenant (après un changement des
   * seuils d'alerte, par exemple), sans attendre le job quotidien.
   */
  @Post('admin/deadlines/recompute')
  recompute(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'tenant.configure');
    return this.deadlines.runForTenant(scope.tenantId, new Date());
  }

  @Get('contracts/:id/deadlines')
  async forContract(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'contracts.read');
    return { items: await this.deadlines.list(scope, new Date('1970-01-01'), new Date('2999-12-31'), id) };
  }
}
