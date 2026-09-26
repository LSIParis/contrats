import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { PortalService } from './portal.service.js';
import { assertCan } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { AcceptanceService, PortalAcceptSchema } from '../negotiation/acceptance.service.js';

class PortalCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le message ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Message trop long (5000 caractères max).' })
  body!: string;
}

@Controller('v1/portal')
export class PortalContractsController {
  constructor(
    private readonly portal: PortalService,
    private readonly acceptance: AcceptanceService,
  ) {}

  /** Texte de la proposition présentée (celui que le client accepte). */
  @Get('contracts/:id/proposal')
  proposal(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'portal.read');
    return this.portal.proposal(scope, id);
  }

  /**
   * Acceptation par le client (distincte de la signature). Identité issue de
   * la SESSION, IP de la requête (trustProxy) : rien n'est déclaratif.
   */
  @Post('contracts/:id/accept')
  async accept(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PortalAcceptSchema)) body: { versionId: string }, @Req() req: FastifyRequest,
  ) {
    assertCan(session, 'portal.accept');
    const me = await this.portal.identity(scope, session.userId);
    const ua = req.headers['user-agent'];
    return this.acceptance.accept(scope, id, {
      method: 'PORTAL', versionId: body.versionId, name: me.fullName, email: me.email, userId: session.userId,
      ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null, evidenceNote: null,
    }, new Date());
  }

  @Get('contracts')
  list(@CurrentScope() scope: Scope) {
    return this.portal.list(scope);
  }

  @Get('contracts/:id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.findOne(scope, id);
  }

  @Get('contracts/:id/sign')
  async sign(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply) {
    const url = await this.portal.signRedirectUrl(scope, id);
    void res.redirect(302, url);
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
