import { Body, Controller, Post } from '@nestjs/common';
import { CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { AiDraftingService } from './ai-drafting.service.js';
import { AiDraftDto } from './dto/ai-draft.dto.js';

@Controller('v1/templates')
export class AiDraftingController {
  constructor(private readonly ai: AiDraftingService) {}

  @Post('ai-draft')
  draft(@CurrentSession() s: Session, @Body() dto: AiDraftDto) {
    assertRole(s, ['MSP_ADMIN', 'LEGAL_REVIEWER']);
    return this.ai.draft({ prompt: dto.prompt, category: dto.category, context: dto.context });
  }
}
