import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { PortalService } from './portal.service.js';

class PortalCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le message ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Message trop long (5000 caractères max).' })
  body!: string;
}

@Controller('v1/portal')
export class PortalContractsController {
  constructor(private readonly portal: PortalService) {}

  @Get('contracts')
  list(@CurrentScope() scope: Scope) {
    return this.portal.list(scope);
  }

  @Get('contracts/:id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.findOne(scope, id);
  }

  @Get('contracts/:id/sign')
  async sign(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const url = await this.portal.signRedirectUrl(scope, id);
    res.redirect(302, url);
  }

  @Get('me')
  async me(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    // L'email vient de la session ; à défaut, on le lit depuis l'utilisateur.
    const email = (session as any).email ?? (await this.portal.emailOf(scope, session.userId));
    return this.portal.me(scope, email);
  }

  @Get('contracts/:id/comments')
  async listComments(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    const items = await this.portal.listComments(scope, id);
    return { items };
  }

  @Post('contracts/:id/comments')
  createComment(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PortalCommentDto) {
    return this.portal.createComment(scope, id, dto.body, new Date());
  }
}
