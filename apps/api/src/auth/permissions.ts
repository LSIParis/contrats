import { ForbiddenException } from '@nestjs/common';
import type { RoleCode, Session } from './session.service.js';

/**
 * Matrice rôle × action. (docs/contrats/00-architecture.md §3.3, brief §9)
 *
 * LA source unique des droits d'action. Les contrôleurs appellent
 * `assertCan(session, 'action')` ; ils ne listent plus de rôles eux-mêmes.
 * Une liste de rôles recopiée dans dix contrôleurs finit toujours par
 * diverger d'un endroit à l'autre — et c'est la divergence qui fait la faille.
 *
 * Rappel (§13.2) : le rôle répond à « qui ». Le « sur quoi » est le scope
 * (RLS), le « dans quel état » est la machine à états. Un droit ici n'ouvre
 * jamais un contrat hors du portefeuille, ni une transition interdite.
 *
 * Correspondance avec le brief :
 *   admin → MSP_ADMIN · commercial → ACCOUNT_MANAGER · juriste/valideur →
 *   LEGAL_REVIEWER · signataire_interne → INTERNAL_SIGNATORY · lecteur →
 *   READER (et TECHNICIAN, historique) · client → CLIENT_SIGNER/CLIENT_VIEWER.
 */
export const PERMISSIONS = {
  // --- Paramétrage du tenant (admin) -------------------------------------
  'tenant.configure': ['MSP_ADMIN'],
  'users.manage': ['MSP_ADMIN'],
  'audit.read': ['MSP_ADMIN'],
  'apiClients.manage': ['MSP_ADMIN'],
  /** Abonnements aux webhooks sortants (URL, secret HMAC, relivraison). */
  'webhooks.manage': ['MSP_ADMIN'],
  'pricing.rules.manage': ['MSP_ADMIN'],
  'pricing.indexes.manage': ['MSP_ADMIN'],
  /** Seconde validation d'une dérogation tarifaire au-delà du seuil. */
  'pricing.override.approve': ['MSP_ADMIN'],

  // --- Bibliothèque (admin + juriste) ------------------------------------
  'templates.manage': ['MSP_ADMIN', 'LEGAL_REVIEWER'],
  'clauses.manage': ['MSP_ADMIN', 'LEGAL_REVIEWER'],
  'templates.aiDraft': ['MSP_ADMIN', 'LEGAL_REVIEWER'],

  // --- Contrats : rédaction, négociation, envoi (commercial) -------------
  'customers.write': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'contracts.write': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'contracts.import': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'contracts.aiDraft': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'],
  'contracts.negotiate': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'contracts.sendForSignature': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'contracts.lifecycle': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'pricing.write': ['MSP_ADMIN', 'ACCOUNT_MANAGER'],
  'pricing.simulate': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'],

  // --- Revue (juriste / valideur) -----------------------------------------
  'contracts.review': ['MSP_ADMIN', 'LEGAL_REVIEWER'],
  'clauses.validateAi': ['MSP_ADMIN', 'LEGAL_REVIEWER'],
  'imports.validate': ['MSP_ADMIN', 'LEGAL_REVIEWER'],

  // --- Signature au nom de LSI --------------------------------------------
  'contracts.signInternal': ['MSP_ADMIN', 'INTERNAL_SIGNATORY'],

  // --- Lecture interne ----------------------------------------------------
  'contracts.read': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'INTERNAL_SIGNATORY', 'READER', 'TECHNICIAN'],
  'comments.internal': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN'],
  'comments.share': ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'],

  // --- Portail client -----------------------------------------------------
  'portal.read': ['CLIENT_SIGNER', 'CLIENT_VIEWER'],
  'portal.accept': ['CLIENT_SIGNER'],
  'portal.sign': ['CLIENT_SIGNER'],
} as const satisfies Record<string, readonly RoleCode[]>;

export type Action = keyof typeof PERMISSIONS;

export const ALL_ROLES: readonly RoleCode[] = [
  'MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'INTERNAL_SIGNATORY', 'READER', 'TECHNICIAN',
  'CLIENT_SIGNER', 'CLIENT_VIEWER',
];

export function can(roles: readonly RoleCode[], action: Action): boolean {
  const allowed: readonly RoleCode[] = PERMISSIONS[action];
  return roles.some((r) => allowed.includes(r));
}

/** 403 si AUCUNE des actions n'est autorisée (lecture partagée par plusieurs métiers). */
export function assertCanAny(session: Session, actions: readonly Action[]): void {
  if (!actions.some((a) => can(session.roles, a))) {
    throw new ForbiddenException(
      `Action réservée : ${actions.join(' ou ')}. Vos rôles : ${session.roles.join(', ') || 'aucun'}.`,
    );
  }
}

/** 403 explicite si aucun des rôles de la session n'autorise l'action. */
export function assertCan(session: Session, action: Action): void {
  if (!can(session.roles, action)) {
    throw new ForbiddenException(
      `Action « ${action} » réservée aux rôles : ${PERMISSIONS[action].join(', ')}. ` +
        `Vos rôles : ${session.roles.join(', ') || 'aucun'}.`,
    );
  }
}
