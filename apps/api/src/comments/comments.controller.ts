import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { EditCommentDto } from './dto/edit-comment.dto.js';

@Controller('v1/contracts')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(':id/comments')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'comments.internal');
    const items = await this.comments.listInternal(scope, id);
    return { items };
  }

  @Post(':id/comments')
  async create(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto,
  ) {
    const visibility = dto.visibility ?? 'INTERNAL';
    assertCan(session, visibility === 'SHARED' ? 'comments.share' : 'comments.internal');
    return this.comments.createInternal(scope, session.userId, id, dto.body, visibility, new Date());
  }

  @Post(':id/comments/:commentId/resolve')
  resolve(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertCan(session, 'comments.internal');
    return this.comments.resolve(scope, id, commentId, session.userId, new Date());
  }

  @Post(':id/comments/:commentId/unresolve')
  unresolve(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertCan(session, 'comments.internal');
    return this.comments.unresolve(scope, id, commentId, new Date());
  }

  @Patch(':id/comments/:commentId/share')
  share(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertCan(session, 'comments.share');
    return this.comments.share(scope, id, commentId, new Date());
  }

  @Patch(':id/comments/:commentId')
  edit(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: EditCommentDto) {
    assertCan(session, 'comments.internal');
    return this.comments.edit(scope, id, commentId, session.userId, session.roles.includes('MSP_ADMIN'), dto.body, new Date());
  }

  @Delete(':id/comments/:commentId')
  remove(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertCan(session, 'comments.internal');
    return this.comments.softDelete(scope, id, commentId, session.userId, session.roles.includes('MSP_ADMIN'), new Date());
  }
}
