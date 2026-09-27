import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { AiGateway } from './ai-gateway.service.js';
import { AiClauseActionSchema, AiDraftContractSchema, ContractAiService, type AiDraftContract } from './contract-ai.service.js';

const UsageQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

/** Assistance IA sur les contrats (lot 6). */
@Controller('v1')
export class ContractAiController {
  constructor(private readonly ai: ContractAiService, private readonly gateway: AiGateway) {}

  @Get('ai/availability')
  availability(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'contracts.read');
    return this.gateway.availability(scope, new Date());
  }

  @Get('admin/ai/usage')
  usage(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(UsageQuery)) q: z.infer<typeof UsageQuery>) {
    assertCan(s, 'tenant.configure');
    return this.gateway.usage(scope, q.month ? new Date(`${q.month}-01T00:00:00Z`) : new Date());
  }

  @Post('contracts/:id/ai/draft')
  draft(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AiDraftContractSchema)) body: AiDraftContract,
  ) {
    assertCan(s, 'contracts.aiDraft');
    return this.ai.draft(scope, id, body, new Date());
  }

  @Post('contracts/:id/clauses/:clauseKey/ai')
  clause(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('clauseKey') clauseKey: string,
    @Body(new ZodPipe(AiClauseActionSchema)) body: z.infer<typeof AiClauseActionSchema>,
  ) {
    assertCan(s, 'contracts.aiDraft');
    return this.ai.assistClause(scope, id, clauseKey, body.action, new Date());
  }

  @Post('contracts/:id/ai/missing-clauses')
  missing(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.aiDraft');
    return this.ai.missingClauses(scope, id, new Date());
  }

  @Post('contracts/:id/import/ai-extract')
  importExtract(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.import');
    return this.ai.importExtract(scope, id, new Date());
  }
}
