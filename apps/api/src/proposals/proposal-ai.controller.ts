import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ProposalAiDraftSchema, ProposalAiRephraseSchema, ProposalAiService, type ProposalAiDraft } from './proposal-ai.service.js';
import { ProposalsService } from './proposals.service.js';

/** Assistance IA à la rédaction des propositions (lot 9.9). */
@Controller('v1/proposals')
export class ProposalAiController {
  constructor(private readonly ai: ProposalAiService, private readonly proposals: ProposalsService) {}

  /** Rédige « Contexte », « Enjeux », « Solution proposée » ; les sections restent à valider. */
  @Post(':id/ai/draft')
  @HttpCode(200)
  draft(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ProposalAiDraftSchema)) body: ProposalAiDraft,
  ) {
    assertCan(s, 'proposals.write');
    return this.ai.draft(scope, id, body, new Date());
  }

  /** Reformulation ou synthèse d'un texte : suggestion, jamais appliquée. */
  @Post(':id/ai/rephrase')
  @HttpCode(200)
  rephrase(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ProposalAiRephraseSchema)) body: z.infer<typeof ProposalAiRephraseSchema>,
  ) {
    assertCan(s, 'proposals.write');
    return this.ai.rephrase(scope, id, body, new Date());
  }

  /** Relecture humaine d'une section générée par IA (lève le bandeau et le blocage d'envoi). */
  @Post(':id/sections/:key/ai-validate')
  @HttpCode(200)
  validate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string) {
    assertCan(s, 'proposals.write');
    return this.proposals.validateAiSection(scope, id, key.slice(0, 64), new Date());
  }
}
