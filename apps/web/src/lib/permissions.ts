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
  // Lot 9 — propositions commerciales.
  'proposals.read': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'INTERNAL_SIGNATORY', 'READER'],
  'proposals.prices.validate': ['MSP_ADMIN'],
} as const satisfies Record<string, readonly string[]>;

export type UiAction = keyof typeof PERMISSIONS;

export function can(roles: readonly string[] | undefined, action: UiAction): boolean {
  const allowed: readonly string[] = PERMISSIONS[action];
  return (roles ?? []).some((r) => allowed.includes(r));
}
