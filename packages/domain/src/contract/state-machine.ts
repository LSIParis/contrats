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

/**
 * Matrice : quels événements sont structurellement possibles par état.
 * Source : docs/contrats/02-cycle-de-vie.md §3 (testée exhaustivement).
 */
const SIGNING: readonly ContractEventType[] = [
  'SIGNER_SIGNED', 'SIGNER_DECLINED', 'SIGNATURE_EXPIRE', 'REVOKE_SIGNATURE', 'CANCEL',
];
const TRANSITIONS: Record<ContractStatus, readonly ContractEventType[]> = {
  DRAFT: ['EDIT_CONTENT', 'SUBMIT_FOR_REVIEW', 'CANCEL'],
  IN_REVIEW: ['APPROVE', 'REQUEST_CHANGES', 'CANCEL'],
  CHANGES_REQUESTED: ['EDIT_CONTENT', 'SUBMIT_FOR_REVIEW', 'CANCEL'],
  // RM-11 : éditer un APPROVED le renvoie en DRAFT et invalide la validation.
  // SEND_FOR_SIGNATURE direct = acceptation implicite (l'acceptation est
  // une faculté du client, pas une étape obligatoire — brief §2 « peut »).
  APPROVED: ['EDIT_CONTENT', 'SEND_TO_CLIENT', 'SEND_FOR_SIGNATURE', 'CANCEL'],
  SENT_TO_CLIENT: ['CLIENT_ACCEPT', 'OPEN_NEGOTIATION', 'CANCEL'],
  IN_NEGOTIATION: ['EDIT_CONTENT', 'SUBMIT_FOR_REVIEW', 'SEND_TO_CLIENT', 'CANCEL'],
  ACCEPTED: ['SEND_FOR_SIGNATURE', 'OPEN_NEGOTIATION', 'CANCEL'],
  // V2-LOCK : aucune édition pendant la signature. Modifier exige de révoquer.
  PENDING_SIGNATURE: SIGNING,
  PARTIALLY_SIGNED: SIGNING,
  // Plus terminal (brief §2) : un refus peut rouvrir la négociation.
  DECLINED: ['REOPEN_NEGOTIATION', 'CANCEL'],
  SIGNATURE_EXPIRED: ['REOPEN_NEGOTIATION', 'SEND_FOR_SIGNATURE', 'CANCEL'],
  // RM-05 : plus aucune édition. RM-22 : plus d'annulation, seule la résiliation.
  SIGNED: ['ACTIVATE', 'TERMINATE'],
  ACTIVE: ['EXPIRE', 'TERMINATE', 'OPEN_RENEWAL', 'MARK_RENEWED'],
  RENEWAL_DUE: ['RENEW_PERIOD', 'CLOSE_RENEWAL', 'MARK_RENEWED', 'EXPIRE', 'TERMINATE'],
  TERMINATION_PENDING: ['COMPLETE_TERMINATION', 'WITHDRAW_TERMINATION'],
  // Pas terminal : le renouvellement tardif rétroactif est un cas réel.
  EXPIRED: ['MARK_RENEWED'],
  // Un contrat papier déjà signé : aucune signature redemandée (brief §3).
  IMPORTED_PENDING_VALIDATION: ['VALIDATE_IMPORT', 'CANCEL'],
  TERMINATED: [],
  RENEWED: [],
  CANCELLED: [],
};

const isEditable = (s: ContractStatus) => (EDITABLE_STATUSES as readonly string[]).includes(s);
export const isTerminal = (s: ContractStatus) => (TERMINAL_STATUSES as readonly string[]).includes(s);

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Minuit UTC du jour de `d`. Neutralise l'heure de `now` pour une comparaison en JOURS. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * RM-20 : le préavis est-il respecté ? Source UNIQUE, en UTC (via `addDays`).
 *
 * Le service applicatif (persistance de `Cancellation.noticeRespected`) et
 * la garde TERMINATE ci-dessous doivent trancher IDENTIQUEMENT — sinon, près
 * d'une frontière de jour dans un process non-UTC, la ligne persistée peut
 * contredire la décision d'admission. D'où l'export.
 *
 * `effectiveDate` vient d'un `<input type=date>` : minuit UTC du jour choisi.
 * La règle métier compare des JOURS ("date d'effet ≥ aujourd'hui + préavis"),
 * pas des instants — `now` est donc ramené à minuit UTC avant d'ajouter le
 * préavis, sinon la frontière exacte (aujourd'hui + préavis) est rejetée à
 * tort dès que `now` a une heure de jour non nulle.
 */
export function isNoticeRespected(
  noticePeriodDays: number | null,
  effectiveDate: Date,
  now: Date,
): boolean {
  return effectiveDate >= addDays(startOfUtcDay(now), noticePeriodDays ?? 0);
}

/**
 * Les événements possibles dans l'état courant, gardes comprises.
 *
 * Alimente `allowed_transitions` dans les réponses d'erreur de l'API (§14.3),
 * pour que l'interface désactive les bons boutons sans réimplémenter la
 * machine — le domaine reste la seule source de vérité.
 */
export function allowedEvents(c: ContractSnapshot, now?: Date): ContractEventType[] {
  const currentIsApproved = c.approvedVersionId !== null && c.approvedVersionId === c.currentVersionId;
  return TRANSITIONS[c.status].filter((e) => {
    switch (e) {
      case 'SUBMIT_FOR_REVIEW':
        return c.hasLsiSigner && c.hasClientSigner && c.hasRequiredAttachments && !!c.startDate && !!c.currentVersionId
          && !c.hasUnreviewedAiClauses && !c.hasMissingVariables;
      case 'SEND_TO_CLIENT':
        return currentIsApproved;
      case 'SEND_FOR_SIGNATURE':
        return c.status === 'ACCEPTED'
          ? currentIsApproved && c.acceptedVersionId === c.currentVersionId
          : currentIsApproved;
      case 'EXPIRE':
      case 'OPEN_RENEWAL':
        return c.endDate !== null;
      case 'VALIDATE_IMPORT':
        return !!c.startDate;
      case 'COMPLETE_TERMINATION':
        return !!c.terminationEffectiveDate && (!now || c.terminationEffectiveDate <= now);
      default:
        return true;
    }
  });
}

/** RM-19 / EC-07 : garde d'avenant. N'est pas une transition du parent. */
export function assertCanAmend(parent: ContractSnapshot): void {
  if (parent.status !== 'ACTIVE' && parent.status !== 'SIGNED' && parent.status !== 'RENEWAL_DUE') {
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

/** RM-16 : un renouvellement ne porte que sur un contrat actif ou expiré. */
export function assertCanRenew(parent: ContractSnapshot): void {
  if (parent.status !== 'ACTIVE' && parent.status !== 'EXPIRED' && parent.status !== 'RENEWAL_DUE') {
    throw new BusinessRuleError(
      `Un renouvellement ne peut porter que sur un contrat actif ou expiré (statut actuel : ${parent.status}).`,
      'RM-16',
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
      if (c.hasUnreviewedAiClauses) {
        throw new BusinessRuleError(
          'Projet généré par IA : chaque clause doit être validée par un humain avant la revue interne.',
          'V2-AI',
        );
      }
      if (c.hasMissingVariables) {
        throw new BusinessRuleError(
          'Des variables du contrat type restent à compléter (marquées « à compléter » dans le texte).',
          'V2-VAR',
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
      // En négociation, le contrat RESTE en négociation, mais la validation
      // interne tombe : la nouvelle version devra être revalidée avant d'être
      // renvoyée au client.
      if (c.status === 'IN_NEGOTIATION') {
        return { ...c, approvedVersionId: null };
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
      if (c.status === 'ACCEPTED' && c.acceptedVersionId !== c.currentVersionId) {
        throw new BusinessRuleError(
          "La version à signer n'est pas celle que le client a acceptée.",
          'V2-ACC',
        );
      }
      // Le passage effectif n'est acté qu'après acquittement du provider
      // (EC-04) : la couche applicative n'appelle applyEvent qu'ensuite.
      return { ...c, status: 'PENDING_SIGNATURE' };
    }

    // -----------------------------------------------------------------
    case 'REVOKE_SIGNATURE': {
      // Révoquer DÉFAIT l'envoi : le contrat revient à l'état qui précédait —
      // ACCEPTED si le client avait accepté cette version, APPROVED sinon.
      // Sa validation reste valable. Ce n'est PAS annuler le contrat (§6.13).
      const accepted = !!c.acceptedVersionId && c.acceptedVersionId === c.currentVersionId;
      return { ...c, status: accepted ? 'ACCEPTED' : 'APPROVED' };
    }

    // -----------------------------------------------------------------
    case 'SEND_TO_CLIENT': {
      if (c.approvedVersionId === null || c.approvedVersionId !== c.currentVersionId) {
        throw new BusinessRuleError(
          'Seule une version validée en revue interne peut être présentée au client.',
          'RM-11',
        );
      }
      return { ...c, status: 'SENT_TO_CLIENT', acceptedVersionId: null };
    }

    case 'CLIENT_ACCEPT': {
      // L'acceptation porte sur une VERSION précise : celle que le client a
      // eue sous les yeux. Accepter « le contrat » en général ne prouve rien.
      if (event.versionId !== c.currentVersionId || c.approvedVersionId !== c.currentVersionId) {
        throw new BusinessRuleError(
          "La version acceptée n'est pas la version présentée au client.",
          'V2-ACC',
        );
      }
      return { ...c, status: 'ACCEPTED', acceptedVersionId: event.versionId };
    }

    case 'OPEN_NEGOTIATION':
    case 'REOPEN_NEGOTIATION': {
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Le motif de la négociation est obligatoire.', 'V2-NEG');
      }
      // Une acceptation antérieure ne vaut plus : on renégocie.
      return { ...c, status: 'IN_NEGOTIATION', acceptedVersionId: null };
    }

    case 'SIGNATURE_EXPIRE': {
      return { ...c, status: 'SIGNATURE_EXPIRED' };
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
    case 'VALIDATE_IMPORT': {
      // L'état d'arrivée se DÉDUIT des dates : l'utilisateur valide les
      // métadonnées, il ne choisit pas le statut (V2-IMP).
      if (!c.startDate) {
        throw new BusinessRuleError("La date d'effet est obligatoire pour valider un import.", 'V2-IMP');
      }
      if (c.endDate && c.endDate < startOfUtcDay(now)) return { ...c, status: 'EXPIRED' };
      if (c.startDate > now) return { ...c, status: 'SIGNED' };
      return { ...c, status: 'ACTIVE', activatedAt: now };
    }

    // -----------------------------------------------------------------
    case 'OPEN_RENEWAL': {
      if (!c.endDate) {
        throw new BusinessRuleError(
          "Un contrat à durée indéterminée ne se renouvelle pas : il se poursuit jusqu'à résiliation.",
          'EC-13',
        );
      }
      return { ...c, status: 'RENEWAL_DUE' };
    }

    case 'RENEW_PERIOD': {
      if (!c.endDate || event.newEndDate <= c.endDate) {
        throw new BusinessRuleError('La nouvelle période doit prolonger le terme actuel.', 'V2-REN');
      }
      return { ...c, status: 'ACTIVE', endDate: event.newEndDate };
    }

    case 'CLOSE_RENEWAL': {
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Un motif est obligatoire.', 'V2-REN');
      }
      return { ...c, status: 'ACTIVE' };
    }

    // -----------------------------------------------------------------
    case 'COMPLETE_TERMINATION': {
      if (!c.terminationEffectiveDate || c.terminationEffectiveDate > now) {
        throw new BusinessRuleError("La date d'effet de la résiliation n'est pas atteinte.", 'RM-20');
      }
      return { ...c, status: 'TERMINATED', terminatedAt: now };
    }

    case 'WITHDRAW_TERMINATION': {
      if (!event.reason.trim()) {
        throw new BusinessRuleError('Le motif du retrait de la résiliation est obligatoire.', 'RM-20');
      }
      return { ...c, status: 'ACTIVE', terminationEffectiveDate: null };
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

      const respectsNotice = isNoticeRespected(c.noticePeriodDays, event.effectiveDate, now);

      if (!respectsNotice) {
        if (!event.isAdmin) {
          const minDate = addDays(startOfUtcDay(now), c.noticePeriodDays ?? 0);
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

      // Brief §2 : ACTIVE → EN_RÉSILIATION → RÉSILIÉ. Tant que la date
      // d'effet n'est pas atteinte, le contrat produit ses effets : il est
      // « en résiliation », pas résilié. Le job quotidien achève la
      // résiliation (COMPLETE_TERMINATION) à la date d'effet.
      if (event.effectiveDate > now) {
        return { ...c, status: 'TERMINATION_PENDING', terminationEffectiveDate: event.effectiveDate };
      }
      return { ...c, status: 'TERMINATED', terminatedAt: now, terminationEffectiveDate: event.effectiveDate };
    }
  }
}
