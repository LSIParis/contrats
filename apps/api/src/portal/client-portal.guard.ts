import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { ScopedRequest } from '../auth/scope.guard.js';

/**
 * Deny-by-default pour les sessions CLIENT (§6.15, H11).
 *
 * Une session `actorKind='CLIENT'` ne peut atteindre QUE `/v1/portal/*`. Toute
 * autre route est refusée (403) — la surface interne n'est jamais exposée au
 * portail, même en lecture. S'exécute APRÈS le ScopeGuard (qui pose req.session).
 */
@Injectable()
export class ClientPortalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ScopedRequest>();
    const session = req.session;
    if (!session) return true; // route @Public / sans session : ScopeGuard a déjà tranché
    if (session.scope.actorKind === 'CLIENT') {
      const path = req.path ?? req.url ?? '';
      if (!path.startsWith('/v1/portal/')) {
        throw new ForbiddenException('Accès réservé à l’espace client.');
      }
    }
    return true;
  }
}
