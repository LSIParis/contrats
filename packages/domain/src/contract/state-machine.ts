import {
  EDITABLE_STATUSES,
  TERMINAL_STATUSES,
  type ContractEvent,
  type ContractEventType,
  type ContractSnapshot,
  type ContractStatus,
} from './contract.types.js';

/**
 * Machine à états du contrat. (§7.2, §7.3)
 *
 * Fonction PURE : (snapshot, événement, horloge) → nouveau snapshot.
 *
 * L'horloge est injectée. Aucun appel à Date.now() ici : une règle métier qui
 * lit l'horloge globale n'est testable qu'en manipulant le temps système.
 *
 * Les gardes vivent ICI, pas dans l'interface ni dans les contrôleurs. Un
 * bouton grisé n'est pas un contrôle d'accès : c'est une politesse.
 */

export class InvalidTransitionError extends Error {
  readonly code = 'CONTRACT_INVALID_TRANSITION';
  constructor(
    readonly currentStatus: ContractStatus,
    readonly attempted: ContractEventType,
    readonly allowedTransitions: readonly ContractEventType[],
  ) {
    super(
      `Un contrat en statut ${currentStatus} ne peut pas subir l'action ${attempted}. ` +
        `Actions possibles : ${allowedTransitions.join(', ') || 'aucune (état terminal)'}.`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export class BusinessRuleError extends Error {
  readonly code = 'CONTRACT_RULE_VIOLATION';
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}

/** Matrice §7.2 : quels événements sont structurellement possibles par état. */
const TRANSITIONS: Record<ContractStatus, readonly ContractEventType[]> = {
  DRAFT: ['EDIT_CONTENT', 'SUBMIT_FOR_REVIEW', 'CANCEL'],
  IN_REVIEW: ['APPROVE', 'REQUEST_CHANGES', 'CANCEL'],
  CHANGES_REQUESTED: ['EDIT_CONTENT', 'SUBMIT_FOR_REVIEW', 'CANCEL'],
  // RM-11 : éditer un APPROVED le renvoie en DRAFT et invalide la validation.
  APPROVED: ['EDIT_CONTENT', 'SEND_FOR_SIGNATURE', 'CANCEL'],
  PENDING_SIGNATURE: ['SIGNER_SIGNED', 'SIGNER_DECLINED', 'REVOKE_SIGNATURE', 'CANCEL'],
  PARTIALLY_SIGNED: ['SIGNER_SIGNED', 'SIGNER_DECLINED', 'REVOKE_SIGNATURE', 'CANCEL'],
  // RM-05 : plus aucune édition. RM-22 : plus d'annulation, seule la résiliation.
  SIGNED: ['ACTIVATE', 'TERMINATE'],
  ACTIVE: ['EXPIRE', 'TERMINATE', 'MARK_RENEWED'],
  // Pas terminal : le renouvellement tardif rétroactif est un cas réel.
  EXPIRED: ['MARK_RENEWED'],
  TERMINATED: [],
  RENEWED: [],
  CANCELLED: [],
  DECLINED: [],
};

const isEditable = (s: ContractStatus) => (EDITABLE_STATUSES as readonly string[]).includes(s);
export const isTerminal = (s: ContractStatus) => (TERMINAL_STATUSES as readonly string[]).includes(s);

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/**
 * Les événements possibles dans l'état courant, gardes comprises.
 *
 * Alimente `allowed_transitions` dans les réponses d'erreur de l'API (§14.3),
 * pour que l'interface désactive les bons boutons sans réimplémenter la
 * machine — le domaine reste la seule source de vérité.
 */
export function allowedEvents(c: ContractSnapshot): ContractEventType[] {
  return TRANSITIONS[c.status].filter((e) => {
    switch (e) {
      case 'SUBMIT_FOR_REVIEW':
        return c.hasLsiSigner && c.hasClientSigner && c.hasRequiredAttachments && !!c.startDate && !!c.currentVersionId;
      case 'SEND_FOR_SIGNATURE':
        return c.approvedVersionId !== null && c.approvedVersionId === c.currentVersionId;
      case 'EXPIRE':
        return c.endDate !== null;
      default:
        return true;
    }
  });
}

/** RM-19 / EC-07 : garde d'avenant. N'est pas une transition du parent. */
export function assertCanAmend(parent: ContractSnapshot): void {
  if (parent.status !== 'ACTIVE' && parent.status !== 'SIGNED') {
    throw new BusinessRuleError(
      `Un avenant ne peut porter que sur un contrat signé ou actif (statut actuel : ${parent.status}). ` +
        `Un contrat non signé n'engage encore personne : il suffit de l'éditer.`,
      'RM-17',
    );
  }
  if (parent.openAmendmentExists) {
    throw new BusinessRuleError(
      'Un avenant est déjà en cours sur ce contrat. Terminez-le ou annulez-le avant d\'en créer un autre.',
      'RM-19',
    );
  }
}

export function applyEvent(
  c: ContractSnapshot,
  event: ContractEvent,
  now: Date,
): ContractSnapshot {
  if (!TRANSITIONS[c.status].includes(event.type)) {
    throw new InvalidTransitionError(c.status, event.type, allowedEvents(c));
  }

  switch (event.type) {
    // -----------------------------------------------------------------
    case 'SUBMIT_FOR_REVIEW': {
      if (!c.hasLsiSigner || !c.hasClientSigner) {
        throw new BusinessRuleError(
          'Un contrat doit avoir au moins un signataire côté LSI et un côté client avant d\'être soumis.',
          'RM-12',
        );
      }
      if (!c.hasRequiredAttachments) {
        // EC-11 : on bloque à la soumission, pas à l'envoi. L'erreur doit
        // arriver avant que le juriste ait perdu son temps.
        throw new BusinessRuleError(
          'Des pièces jointes obligatoires sont manquantes.',
          'EC-11',
        );
      }
      if (!c.startDate) {
        throw new BusinessRuleError('La date de début est obligatoire.', 'RM-08');
      }
      if (!c.currentVersionId) {
        throw new BusinessRuleError(
          'Le contrat doit avoir un contenu rédigé avant d\'être soumis.',
          'RM-11',
        );
      }
      return { ...c, status: 'IN_REVIEW', submittedByUserId: event.actorUserId };
    }

    // -----------------------------------------------------------------
    case 'APPROVE': {
      if (c.submittedByUserId === event.actorUserId) {
        throw new BusinessRuleError(
          'Vous avez soumis ce contrat : sa validation revient à une autre personne.',
          'RM-10',
        );
      }
      // RM-11 : la validation est liée à la version courante, pas au contrat.
      return { ...c, status: 'APPROVED', approvedVersionId: c.currentVersionId };
    }

    case 'REQUEST_CHANGES': {
      if (c.submittedByUserId === event.actorUserId) {
        throw new BusinessRuleError(
          'Vous avez soumis ce contrat : sa revue revient à une autre personne.',
          'RM-10',
        );
      }
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Un motif est obligatoire.', 'RM-11');
      }
      return { ...c, status: 'CHANGES_REQUESTED' };
    }

    // -----------------------------------------------------------------
    case 'EDIT_CONTENT': {
      // RM-11 : toute modification après validation invalide cette validation.
      if (c.status === 'APPROVED') {
        return { ...c, status: 'DRAFT', approvedVersionId: null };
      }
      if (!isEditable(c.status)) {
        throw new InvalidTransitionError(c.status, event.type, allowedEvents(c));
      }
      return c;
    }

    // -----------------------------------------------------------------
    case 'SEND_FOR_SIGNATURE': {
      if (c.approvedVersionId === null) {
        throw new BusinessRuleError('Ce contrat n\'a pas de validation interne.', 'RM-09');
      }
      if (c.approvedVersionId !== c.currentVersionId) {
        throw new BusinessRuleError(
          'Le contrat a été modifié depuis sa validation. Il doit être revalidé avant envoi.',
          'RM-11',
        );
      }
      // Le passage effectif n'est acté qu'après acquittement du provider
      // (EC-04) : la couche applicative n'appelle applyEvent qu'ensuite.
      return { ...c, status: 'PENDING_SIGNATURE' };
    }

    // -----------------------------------------------------------------
    case 'REVOKE_SIGNATURE': {
      // Révoquer DÉFAIT l'envoi : le contrat redevient approuvé (envoyable),
      // sa validation reste valable. Ce n'est PAS annuler le contrat (§6.13).
      return { ...c, status: 'APPROVED' };
    }

    // -----------------------------------------------------------------
    case 'SIGNER_SIGNED': {
      if (!event.allSigned) {
        return { ...c, status: 'PARTIALLY_SIGNED' };
      }
      return { ...c, status: 'SIGNED', signedAt: now };
    }

    case 'SIGNER_DECLINED': {
      return { ...c, status: 'DECLINED' };
    }

    // -----------------------------------------------------------------
    case 'ACTIVATE': {
      if (!c.startDate) {
        throw new BusinessRuleError('La date de début est obligatoire.', 'RM-08');
      }
      // RM-06 : un contrat signé dont la prise d'effet est future RESTE signé.
      if (c.startDate > now) {
        return c;
      }
      return { ...c, status: 'ACTIVE', activatedAt: now };
    }

    // -----------------------------------------------------------------
    case 'EXPIRE': {
      if (!c.endDate) {
        throw new BusinessRuleError(
          'Un contrat à durée indéterminée n\'expire pas. Il doit être résilié.',
          'EC-13',
        );
      }
      if (c.endDate >= now) {
        throw new BusinessRuleError('Le contrat n\'a pas atteint son terme.', 'RM-07');
      }
      // RM-07 : un successeur signé transforme l'expiration en renouvellement.
      return { ...c, status: c.hasSignedSuccessor ? 'RENEWED' : 'EXPIRED' };
    }

    case 'MARK_RENEWED': {
      return { ...c, status: 'RENEWED' };
    }

    // -----------------------------------------------------------------
    case 'CANCEL': {
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Un motif d\'annulation est obligatoire.', 'RM-22');
      }
      return { ...c, status: 'CANCELLED' };
    }

    // -----------------------------------------------------------------
    case 'TERMINATE': {
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Un motif de résiliation est obligatoire.', 'RM-20');
      }

      const minDate = addDays(now, c.noticePeriodDays ?? 0);
      const respectsNotice = event.effectiveDate >= minDate;

      if (!respectsNotice) {
        if (!event.isAdmin) {
          throw new BusinessRuleError(
            `Le préavis de ${c.noticePeriodDays} jours n'est pas respecté : ` +
              `la date d'effet ne peut pas précéder le ${minDate.toISOString().slice(0, 10)}. ` +
              `Seul un administrateur peut y déroger.`,
            'RM-20',
          );
        }
        if (!event.overrideReason?.trim()) {
          throw new BusinessRuleError(
            'Déroger au préavis exige une justification, qui sera tracée.',
            'RM-20',
          );
        }
      }

      return { ...c, status: 'TERMINATED', terminatedAt: now };
    }
  }
}
