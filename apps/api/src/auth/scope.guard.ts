import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { SessionService, type Session } from './session.service.js';

export interface ScopedRequest {
  session?: Session;
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Guard GLOBAL de scope. (§10.5)
 *
 * Enregistré via APP_GUARD : il s'applique à TOUTES les routes, présentes et
 * futures. C'est la raison principale du choix NestJS plutôt que Next.js
 * (§9.2) : avec des route handlers, le scoping serait une convention — 35
 * handlers, 35 occasions d'oublier, et l'oubli ne casse rien, il élargit
 * silencieusement le périmètre. Ici, une route nouvelle est gardée par
 * défaut ; s'en soustraire exige @Public(), qui est visible en revue.
 *
 * Le scope N'EST JAMAIS lu depuis la requête (RM-29) : ni URL, ni body, ni
 * query, ni header. Il vient de la session serveur, résolue au login.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<ScopedRequest>();
    const sessionId = this.readSessionCookie(req);
    if (!sessionId) throw new UnauthorizedException('Session absente');

    // Lecture Redis à CHAQUE requête : c'est ce qui donne la révocation
    // immédiate et un scope toujours frais (EC-17). Une session révoquée
    // n'existe plus, la requête est refusée.
    const session = await this.sessions.get(sessionId);
    if (!session) throw new UnauthorizedException('Session invalide ou expirée');

    req.session = session;
    return true;
  }

  private readSessionCookie(req: ScopedRequest): string | undefined {
    // __Host- : le préfixe interdit au cookie d'être posé par un sous-domaine
    // et impose Secure + Path=/ (§13.1).
    const fromCookie = req.cookies?.['__Host-lsi_sess'];
    if (fromCookie) return fromCookie;

    // Utilisé par les tests d'intégration ; en production le cookie est seul.
    const h = req.headers['x-lsi-session'];
    return typeof h === 'string' ? h : undefined;
  }
}
