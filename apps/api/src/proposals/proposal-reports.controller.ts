import { Controller, Get, Header, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { PipelineQuery, ProposalReportingService, ReportQuery } from './proposal-reporting.service.js';
import { ProposalsService } from './proposals.service.js';

/** Pilotage commercial (lot 9.8) : pipeline, tableau de bord, export CSV. */
@Controller('v1/proposal-reports')
export class ProposalReportsController {
  constructor(private readonly reporting: ProposalReportingService, private readonly proposals: ProposalsService) {}

  @Get('pipeline')
  async pipeline(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(PipelineQuery)) q: z.infer<typeof PipelineQuery>) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    return this.reporting.pipeline(scope, q);
  }

  @Get('dashboard')
  async dashboard(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    return this.reporting.dashboard(scope, q, new Date());
  }

  @Get('dashboard.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="indicateurs-propositions.csv"')
  async csv(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    return this.reporting.dashboardCsv(scope, q, new Date());
  }
}
