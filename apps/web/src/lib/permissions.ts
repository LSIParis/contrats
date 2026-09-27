/**
 * Miroir CLIENT de la matrice rôle × action de l'API (apps/api/src/auth/permissions.ts).
 *
 * Sert UNIQUEMENT à masquer ou désactiver des commandes : l'API reste seule juge
 * (elle répond 403 si le rôle ne suffit pas). Ne lister ici que les actions dont
 * l'interface a besoin, avec exactement les rôles de l'API.
 */
const PERMISSIONS = {
  'tenant.configure': ['MSP_ADMIN'],
  'contracts.import': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'imports.validate': ['MSP_ADMIN', 'LEGAL_REVIEWER'],
  // Tarification (lot 3) et administration (lots 6-7).
  'pricing.write': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'pricing.simulate': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'],
  'pricing.override.approve': ['MSP_ADMIN'],
  'pricing.rules.manage': ['MSP_ADMIN'],
  'pricing.indexes.manage': ['MSP_ADMIN'],
  'apiClients.manage': ['MSP_ADMIN'],
  'webhooks.manage': ['MSP_ADMIN'],
} as const satisfies Record<string, readonly string[]>;

export type UiAction = keyof typeof PERMISSIONS;

export function can(roles: readonly string[] | undefined, action: UiAction): boolean {
  const allowed: readonly string[] = PERMISSIONS[action];
  return (roles ?? []).some((r) => allowed.includes(r));
}

/**
 * Droit d'une session : la liste `permissions` renvoyée par `/v1/auth/me`
 * (calculée par l'API depuis SA matrice) fait foi quand elle est présente ;
 * sinon, repli sur le miroir ci-dessus à partir des rôles.
 */
export function canDo(me: { roles?: readonly string[]; permissions?: readonly string[] } | undefined, action: UiAction): boolean {
  if (Array.isArray(me?.permissions)) return me.permissions.includes(action);
  return can(me?.roles, action);
}
