import {
  PROPOSAL_TERMINAL_STATUSES,
  type ProposalEvent,
  type ProposalEventType,
  type ProposalSnapshot,
  type ProposalStatus,
} from './proposal.types.js';

/**
 * Machine à états de la proposition commerciale (brief §12.2,
 * docs/contrats/11-propositions.md §3).
 *
 * Fonction PURE : (snapshot, événement, horloge) → nouveau snapshot. Mêmes
 * principes que la machine du contrat : l'horloge est injectée, les gardes
 * vivent ici, jamais dans un contrôleur ni dans l'interface.
 */

export class ProposalTransitionError extends Error {
  readonly code = 'PROPOSAL_INVALID_TRANSITION';
  constructor(
    readonly currentStatus: ProposalStatus,
    readonly attempted: ProposalEventType,
    readonly allowedTransitions: readonly ProposalEventType[],
  ) {
    super(
      `Une proposition en statut ${currentStatus} ne peut pas subir l'action ${attempted}. ` +
        `Actions possibles : ${allowedTransitions.join(', ') || 'aucune (état terminal)'}.`,
    );
    this.name = 'ProposalTransitionError';
  }
}

export class ProposalRuleError extends Error {
  readonly code = 'PROPOSAL_RULE_VIOLATION';
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
    this.name = 'ProposalRuleError';
  }
}

/** Matrice structurelle (testée exhaustivement). */
const OPEN: readonly ProposalEventType[] = ['EXPIRE', 'DECLINE', 'WITHDRAW', 'REVISE'];
const TRANSITIONS: Record<ProposalStatus, readonly ProposalEventType[]> = {
  DRAFT: ['SUBMIT_FOR_REVIEW', 'MARK_READY'],
  IN_INTERNAL_REVIEW: ['APPROVE_REVIEW', 'REJECT_REVIEW'],
  // Une proposition prête mais pas encore envoyée se modifie encore :
  // REVISE la ramène en brouillon (sa version n'est pas encore figée).
  READY: ['SEND', 'REVISE'],
  SENT: ['VIEW', ...OPEN],
  VIEWED: ['OPEN_DISCUSSION', 'ACCEPT', ...OPEN],
  IN_DISCUSSION: ['CLOSE_DISCUSSION', 'ACCEPT', ...OPEN],
  // Acceptée mais pas encore signée : la version n'est pas signée, une
  // nouvelle version peut encore la remplacer (V2-H42).
  ACCEPTED: ['START_SIGNATURE', 'COMPLETE_CLICK_ACCEPT', 'REVISE'],
  // Pendant la signature, rien ne bouge côté LSI : seul DocuSeal conclut.
  PENDING_SIGNATURE: ['SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED'],
  SIGNED: ['CONVERT'],
  EXPIRED: ['REACTIVATE'],
  CONVERTED: [],
  DECLINED: [],
  WITHDRAWN: [],
};

export const isProposalTerminal = (s: ProposalStatus): boolean =>
  (PROPOSAL_TERMINAL_STATUSES as readonly string[]).includes(s);

const isExpiredAt = (p: ProposalSnapshot, now: Date): boolean => p.expiresAt !== null && p.expiresAt <= now;

/** Motif des gardes de préparation, ou null si la proposition peut être présentée. */
function readinessIssue(p: ProposalSnapshot): ProposalRuleError | null {
  if (!p.currentVersionId) return new ProposalRuleError('La proposition n’a pas de contenu.', 'P-CONTENT');
  if (!p.hasRecipients) return new ProposalRuleError('Ajoutez au moins un destinataire.', 'P-RECIPIENTS');
  if (!p.hasSigner) {
    return new ProposalRuleError(
      'Désignez au moins un signataire (ou un décideur pour l’acceptation par clic).',
      'P-RECIPIENTS',
    );
  }
  if (p.unresolvedMergeTags > 0) {
    return new ProposalRuleError(
      `${p.unresolvedMergeTags} balise(s) de fusion non résolue(s) : aucune balise ne part chez le client.`,
      'P-MERGE-TAGS',
    );
  }
  if (p.blockingValidations > 0) {
    return new ProposalRuleError(
      `${p.blockingValidations} élément(s) « à valider » (prix, règle ou section) : un administrateur doit les valider avant envoi.`,
      'P-TO-VALIDATE',
    );
  }
  if (p.pricingErrors > 0) {
    return new ProposalRuleError('Le tableau de prix n’est pas calculable en l’état (voir les erreurs).', 'P-PRICING');
  }
  return null;
}

/** Événements possibles dans l'état courant, gardes comprises (alimente l'interface). */
export function allowedProposalEvents(p: ProposalSnapshot, now: Date): ProposalEventType[] {
  return TRANSITIONS[p.status].filter((e) => {
    switch (e) {
      case 'SUBMIT_FOR_REVIEW':
        return readinessIssue(p) === null;
      case 'MARK_READY':
        return readinessIssue(p) === null && !p.reviewRequired;
      case 'ACCEPT':
      case 'START_SIGNATURE':
        return !isExpiredAt(p, now) && (e !== 'START_SIGNATURE' || p.acceptanceMode === 'DOCUSEAL_SIGNATURE');
      case 'COMPLETE_CLICK_ACCEPT':
        return p.acceptanceMode === 'CLICK_ACCEPT';
      case 'EXPIRE':
        return isExpiredAt(p, now);
      default:
        return true;
    }
  });
}

function requireText(value: string | undefined, what: string): void {
  if (!value || !value.trim()) throw new ProposalRuleError(`Un ${what} est obligatoire.`, 'P-REASON');
}

export function applyProposalEvent(p: ProposalSnapshot, event: ProposalEvent, now: Date): ProposalSnapshot {
  if (!TRANSITIONS[p.status].includes(event.type)) {
    throw new ProposalTransitionError(p.status, event.type, allowedProposalEvents(p, now));
  }

  switch (event.type) {
    case 'SUBMIT_FOR_REVIEW': {
      const issue = readinessIssue(p);
      if (issue) throw issue;
      return { ...p, status: 'IN_INTERNAL_REVIEW', reviewSubmittedByUserId: event.actorUserId, reviewApprovedVersionId: null };
    }

    case 'APPROVE_REVIEW':
    case 'REJECT_REVIEW': {
      // Comme RM-10 pour le contrat : sans séparation, la revue est un théâtre.
      if (p.reviewSubmittedByUserId === event.actorUserId) {
        throw new ProposalRuleError(
          'Vous avez soumis cette proposition : sa revue revient à une autre personne.',
          'P-REVIEW-SEPARATION',
        );
      }
      if (event.type === 'REJECT_REVIEW') {
        requireText(event.reason, 'motif');
        return { ...p, status: 'DRAFT', reviewApprovedVersionId: null };
      }
      const issue = readinessIssue(p);
      if (issue) throw issue;
      return { ...p, status: 'READY', reviewApprovedVersionId: p.currentVersionId };
    }

    case 'MARK_READY': {
      const issue = readinessIssue(p);
      if (issue) throw issue;
      if (p.reviewRequired) {
        throw new ProposalRuleError(
          'Revue interne obligatoire (remise, clause dérogatoire ou montant au-delà du seuil du tenant) : soumettez-la à un valideur.',
          'P-REVIEW-REQUIRED',
        );
      }
      return { ...p, status: 'READY' };
    }

    case 'SEND': {
      if (event.expiresAt <= now) {
        throw new ProposalRuleError('La date d’expiration doit être future.', 'P-EXPIRY');
      }
      return { ...p, status: 'SENT', expiresAt: event.expiresAt, acceptedVersionId: null };
    }

    case 'VIEW':
      return { ...p, status: 'VIEWED' };
    case 'OPEN_DISCUSSION':
      return { ...p, status: 'IN_DISCUSSION' };
    case 'CLOSE_DISCUSSION':
      return { ...p, status: 'VIEWED' };

    case 'ACCEPT': {
      // L'acceptation porte sur la version COURANTE : une version remplacée
      // (nouvelle version envoyée) ne peut plus être acceptée.
      if (event.versionId !== p.currentVersionId) {
        throw new ProposalRuleError('Cette version a été remplacée : elle ne peut plus être acceptée.', 'P-SUPERSEDED');
      }
      if (isExpiredAt(p, now)) {
        throw new ProposalRuleError('Cette proposition est expirée : elle ne peut plus être acceptée.', 'P-EXPIRED');
      }
      return { ...p, status: 'ACCEPTED', acceptedVersionId: event.versionId };
    }

    case 'START_SIGNATURE': {
      if (p.acceptanceMode !== 'DOCUSEAL_SIGNATURE') {
        throw new ProposalRuleError('Proposition en mode CLICK_ACCEPT : pas de signature électronique.', 'P-MODE');
      }
      if (isExpiredAt(p, now)) {
        throw new ProposalRuleError('Cette proposition est expirée : elle ne peut plus être signée.', 'P-EXPIRED');
      }
      if (p.acceptedVersionId !== p.currentVersionId) {
        throw new ProposalRuleError('La version à signer n’est pas celle que le client a acceptée.', 'P-SUPERSEDED');
      }
      return { ...p, status: 'PENDING_SIGNATURE' };
    }

    case 'COMPLETE_CLICK_ACCEPT': {
      if (p.acceptanceMode !== 'CLICK_ACCEPT') {
        throw new ProposalRuleError('Proposition en mode DOCUSEAL_SIGNATURE : la signature électronique est requise.', 'P-MODE');
      }
      return { ...p, status: 'SIGNED' };
    }

    case 'SIGNATURE_COMPLETED':
      return { ...p, status: 'SIGNED' };
    case 'SIGNATURE_DECLINED':
    case 'SIGNATURE_EXPIRED':
      // Brief §12.6 (5) : refus ou expiration de la soumission → retour en
      // discussion. L'acceptation tombe : il faudra réaccepter.
      return { ...p, status: 'IN_DISCUSSION', acceptedVersionId: null };

    case 'CONVERT':
      return { ...p, status: 'CONVERTED' };

    case 'EXPIRE': {
      if (!isExpiredAt(p, now)) {
        throw new ProposalRuleError('L’échéance de la proposition n’est pas atteinte.', 'P-EXPIRY');
      }
      return { ...p, status: 'EXPIRED' };
    }

    case 'DECLINE':
      requireText(event.reasonCode, 'motif de refus');
      return { ...p, status: 'DECLINED' };

    case 'WITHDRAW':
      requireText(event.reason, 'motif');
      return { ...p, status: 'WITHDRAWN' };

    case 'REACTIVATE': {
      requireText(event.reason, 'motif');
      if (event.expiresAt <= now) {
        throw new ProposalRuleError('La nouvelle date d’expiration doit être future.', 'P-EXPIRY');
      }
      return { ...p, status: 'READY', expiresAt: event.expiresAt };
    }

    case 'REVISE':
      // Nouvelle version : la validation interne et l'acceptation portaient
      // sur l'ancienne, elles tombent.
      return { ...p, status: 'DRAFT', reviewApprovedVersionId: null, acceptedVersionId: null };
  }
}
