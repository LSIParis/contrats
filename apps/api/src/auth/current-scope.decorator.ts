import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { ScopedRequest } from './scope.guard.js';
import type { RoleCode, Session } from './session.service.js';

/**
 * Injecte le Scope de la session courante.
 *
 * LE SEUL moyen pour un contrôleur d'obtenir un scope. Il n'existe aucune
 * fonction publique qui construise un Scope depuis une entrée utilisateur :
 * la seule source est la session (RM-29).
 */
export const CurrentScope = createParamDecorator((_d: unknown, ctx: ExecutionContext): Scope => {
  const req = ctx.switchToHttp().getRequest<ScopedRequest>();
  if (!req.session) {
    // Ne devrait jamais arriver : le guard global s'exécute avant. Si cela
    // arrive, c'est qu'une route est @Public() tout en demandant un scope —
    // une incohérence qu'il vaut mieux faire exploser que deviner.
    throw new ForbiddenException('Aucun scope : route publique demandant un scope ?');
  }
  return req.session.scope;
});

export const CurrentSession = createParamDecorator((_d: unknown, ctx: ExecutionContext): Session => {
  const req = ctx.switchToHttp().getRequest<ScopedRequest>();
  if (!req.session) throw new ForbiddenException('Aucune session');
  return req.session;
});

/**
 * Contrôle de RÔLE — orthogonal au scope et à l'état (§13.2).
 *
 * Trois questions distinctes, trois réponses distinctes :
 *   qui         → rôle       (ici)
 *   sur quoi    → scope      (RLS)
 *   dans quel état → machine à états (domaine)
 *
 * Les mélanger produit les bugs d'autorisation les plus difficiles à voir.
 * Un MSP_ADMIN a le rôle pour envoyer en signature et le scope sur tous les
 * clients — mais ne peut pas envoyer un contrat en DRAFT.
 */
export function assertRole(session: Session, allowed: readonly RoleCode[]): void {
  if (!session.roles.some((r) => allowed.includes(r))) {
    throw new ForbiddenException(
      `Action réservée aux rôles : ${allowed.join(', ')}. Vos rôles : ${session.roles.join(', ')}.`,
    );
  }
}
