import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail } from 'class-validator';
import { findTenantBySlug } from '@lsi/persistence';
import { Public } from './public.decorator.js';
import { MagicLinkService } from './magic-link.service.js';
import { SessionService } from './session.service.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE } from './cookie.js';

class RequestLinkDto {
  @IsEmail()
  email!: string;
}

/**
 * Authentification du portail client. (§13.1)
 *
 * @Public() sur les endpoints de login (par définition, pas encore de session).
 * Namespace /v1/portal/auth — séparé de l'interne.
 */
@Controller('v1/portal/auth')
export class PortalAuthController {
  constructor(
    private readonly magic: MagicLinkService,
    private readonly sessions: SessionService,
  ) {}

  private async tenantId(): Promise<string | null> {
    return findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi');
  }

  @Public()
  @Post('request-link')
  @HttpCode(200)
  async requestLink(@Body() dto: RequestLinkDto) {
    const tenantId = await this.tenantId();
    if (tenantId) {
      await this.magic.request(tenantId, dto.email, new Date());
    }
    // Réponse TOUJOURS identique, que le compte existe ou non (§13.3).
    return { message: 'Si un compte existe pour cette adresse, un lien vient d’être envoyé.' };
  }

  @Public()
  @Get('verify')
  async verify(@Query('token') token: string, @Res({ passthrough: true }) res: Response) {
    const result = token ? await this.magic.verify(token) : null;
    if (!result) {
      // 410 Gone : lien expiré ou déjà utilisé (§14.2).
      res.status(410);
      return { code: 'MAGIC_LINK_INVALID', message: 'Lien invalide ou expiré.' };
    }
    setSessionCookie(res, result.sessionId, result.ttl);
    return { message: 'Connecté.' };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sid = (req as any).cookies?.[SESSION_COOKIE] ?? req.headers['x-lsi-session'];
    if (typeof sid === 'string') await this.sessions.revoke(sid);
    clearSessionCookie(res);
    return { message: 'Déconnecté.' };
  }
}
