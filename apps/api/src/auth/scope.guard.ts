import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { adminScope, findTenantBySlug } from '@lsi/persistence';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { IS_SERVICE_READABLE_KEY } from './service-readable.decorator.js';
import { SessionService, type Session } from './session.service.js';
import { SESSION_COOKIE } from './cookie.js';

export interface ScopedRequest {
  session?: Session;
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Posé par Express ; utilisé par ClientPortalGuard pour confiner /v1/portal/*. */
  path?: string;
  url?: string;
}

/**
 * Guard GLOBAL de scope. (§10.5)
 *
 * Deux chemins d'authentification :
 *  1. Cookie de session (SSO M365) — prioritaire, inchangé.
 *  2. Clé d'API de service (header X-Api-Key), UNIQUEMENT sur les routes
 *     @ServiceReadable() (lecture seule des contrats), pour l'intégration
 *     serveur-à-serveur du ticketing.
 *
 * Le scope N'EST JAMAIS lu depuis la requête (RM-29) : il vient de la session
 * serveur (cookie) ou d'un scope de service dérivé en base (clé d'API).
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

    // Chemin 1 : cookie de session, prioritaire et inchangé.
    const sessionId = this.readSessionCookie(req);
    if (sessionId) {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new UnauthorizedException('Session invalide ou expirée');
      req.session = session;
      return true;
    }

    // Chemin 2 : clé d'API de service, bornée aux routes @ServiceReadable.
    const apiKey = this.readApiKey(req);
    if (apiKey) {
      const isServiceReadable = this.reflector.getAllAndOverride<boolean>(
        IS_SERVICE_READABLE_KEY,
        [ctx.getHandler(), ctx.getClass()],
      );
      if (!isServiceReadable) {
        throw new UnauthorizedException('Clé API non autorisée sur cette route');
      }
      const expected = process.env.CONTRACT_SERVICE_API_KEY;
      // Jamais valide sans configuration : la clé ne « marche » pas par défaut.
      if (!expected || !this.constantTimeEquals(apiKey, expected)) {
        throw new UnauthorizedException('Clé API invalide');
      }
      req.session = await this.buildServiceSession();
      return true;
    }

    throw new UnauthorizedException('Session absente');
  }

  private readSessionCookie(req: ScopedRequest): string | undefined {
    const fromCookie = req.cookies?.[SESSION_COOKIE];
    if (fromCookie) return fromCookie;
    const h = req.headers['x-lsi-session'];
    return typeof h === 'string' ? h : undefined;
  }

  private readApiKey(req: ScopedRequest): string | undefined {
    const h = req.headers['x-api-key'];
    return typeof h === 'string' ? h : undefined;
  }

  /** Comparaison à temps constant (cf. docuseal.adapter) : un === fuit la
   * position du premier octet divergent. */
  private constantTimeEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** Session de service : scope admin (allCustomers) sur le tenant par défaut,
   * résolu en base comme au login. Read-only garanti par @ServiceReadable. */
  private async buildServiceSession(): Promise<Session> {
    const tenantId = await findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi');
    if (!tenantId) throw new UnauthorizedException('Tenant de service introuvable');
    return {
      sessionId: 'service:ticketing',
      userId: 'service:ticketing',
      tenantId,
      roles: [],
      scope: adminScope(tenantId, 'service:ticketing'),
    };
  }
}
