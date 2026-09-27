import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from './public.decorator.js';
import { OidcAuthService } from './oidc-auth.service.js';
import { setSessionCookie } from './cookie.js';

/**
 * Authentification interne (équipes LSI) par OIDC Entra ID. (§13.1)
 *
 * @Public sur les deux endpoints (login) : par définition, pas de session
 * quand on se connecte.
 */
@Controller('v1/auth')
export class InternalAuthController {
  constructor(private readonly oidc: OidcAuthService) {}

  /** Redirige le navigateur vers Entra ID. */
  @Public()
  @Get('login')
  async login(@Res() res: FastifyReply) {
    const url = await this.oidc.begin();
    void res.redirect(302, url);
  }

  /** Retour d'Entra : valide, ouvre la session, revient sur l'app. */
  @Public()
  @Get('callback')
  async callback(@Query('state') state: string, @Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const appUrl = process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr';
    // L'URL complète (avec code & state) est nécessaire à openid-client pour
    // valider la réponse d'autorisation.
    const currentUrl = `${appUrl}${req.originalUrl ?? req.url}`;

    const result = await this.oidc.complete(currentUrl, state);
    if (!result) {
      // Échec : on renvoie vers l'app avec un marqueur d'erreur, pas une
      // page blanche. Redirect construit depuis une constante (pas d'entrée).
      return res.redirect(302, `${appUrl}/login?error=auth_failed`);
    }
    setSessionCookie(res, result.sessionId, result.ttl);
    return res.redirect(302, `${appUrl}/dashboard`);
  }
}
