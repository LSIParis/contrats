import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';

const COMMENT_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'] as const;

@Controller('v1/contracts')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(':id/comments')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, [...COMMENT_ROLES]);
    const items = await this.comments.listInternal(scope, id);
    return { items };
  }

  @Post(':id/comments')
  async create(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto,
  ) {
    assertRole(session, [...COMMENT_ROLES]);
    return this.comments.createInternal(scope, session.userId, id, dto.body, dto.visibility ?? 'INTERNAL', new Date());
  }
}
