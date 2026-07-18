import { unsafeUnscopedClient } from './scoped-client.js';
import {
  adminScope,
  internalScope,
  clientScope,
  type Scope,
} from './scope.js';

/**
 * Résolution du scope d'un utilisateur au login. (§10.4)
 *
 * Appelle la fonction SECURITY DEFINER `app_resolve_user_scope` : l'élévation
 * de privilège est bornée à cette fonction, il n'y a pas de rôle d'exception
 * supplémentaire. lsi_app peut l'exécuter ; elle ne renvoie que les données
 * de scope de l'utilisateur demandé.
 *
 * On utilise le client applicatif directement (hors withScope) parce que la
 * fonction ne dépend d'aucun GUC de scope — elle EST le mécanisme qui
 * établit le scope. C'est l'unique lecture légitime « avant scope », et elle
 * vit dans persistence, le seul module autorisé à toucher le client brut.
 */

export type ResolvedRole =
  | 'MSP_ADMIN'
  | 'ACCOUNT_MANAGER'
  | 'LEGAL_REVIEWER'
  | 'TECHNICIAN'
  | 'CLIENT_SIGNER'
  | 'CLIENT_VIEWER';

export interface ResolvedUserScope {
  readonly scope: Scope;
  readonly roles: readonly ResolvedRole[];
  readonly kind: 'INTERNAL' | 'CLIENT';
}

/** Résout l'id du tenant par son slug (déploiement mono-tenant). */
export async function findTenantBySlug(slug: string): Promise<string | null> {
  const rows = await unsafeUnscopedClient.$queryRaw<
    { app_find_tenant_by_slug: string | null }[]
  >`SELECT app_find_tenant_by_slug(${slug})`;
  return rows[0]?.app_find_tenant_by_slug ?? null;
}

/**
 * Trouve un utilisateur ACTIF par email, pour amorcer un login (magic link).
 * Ne renvoie que l'id et le kind. Null si aucun compte actif.
 */
export async function findLoginUser(
  tenantId: string,
  email: string,
): Promise<{ userId: string; kind: 'INTERNAL' | 'CLIENT' } | null> {
  const rows = await unsafeUnscopedClient.$queryRaw<
    { user_id: string; kind: 'INTERNAL' | 'CLIENT' }[]
  >`SELECT * FROM app_find_login_user(${tenantId}::uuid, ${email}::text)`;
  const r = rows[0];
  return r ? { userId: r.user_id, kind: r.kind } : null;
}

/**
 * Retourne le scope + les rôles d'un utilisateur actif, ou null s'il
 * n'existe pas / est désactivé.
 */
export async function resolveUserScope(
  tenantId: string,
  userId: string,
): Promise<ResolvedUserScope | null> {
  const rows = await unsafeUnscopedClient.$queryRaw<
    {
      user_kind: 'INTERNAL' | 'CLIENT';
      customer_id: string | null;
      all_customers: boolean;
      role_codes: string[];
      customer_ids: string[];
    }[]
  >`SELECT * FROM app_resolve_user_scope(${tenantId}::uuid, ${userId}::uuid)`;

  const r = rows[0];
  if (!r) return null;

  const roles = r.role_codes as ResolvedRole[];

  let scope: Scope;
  if (r.user_kind === 'CLIENT') {
    // La fonction garantit customer_id non nul pour un CLIENT.
    scope = clientScope(tenantId, r.customer_id!, userId);
  } else if (r.all_customers) {
    scope = adminScope(tenantId, userId);
  } else {
    scope = internalScope(tenantId, r.customer_ids, userId);
  }

  return { scope, roles, kind: r.user_kind };
}
