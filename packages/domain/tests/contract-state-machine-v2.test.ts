import { describe, test, expect } from 'vitest';
import {
  applyEvent,
  allowedEvents,
  InvalidTransitionError,
  BusinessRuleError,
  isTerminal,
} from '../src/contract/state-machine.js';
import {
  CONTRACT_STATUSES,
  type ContractEvent,
  type ContractEventType,
  type ContractSnapshot,
  type ContractStatus,
} from '../src/contract/contract.types.js';

/**
 * Machine à états v2 — docs/contrats/02-cycle-de-vie.md §3.
 *
 * La constante EXPECTED ci-dessous est la table du §3 recopiée à la main.
 * Le test exhaustif vérifie les 20 états × 25 événements : chaque couple
 * absent de la table DOIT lever InvalidTransitionError ; chaque couple
 * présent DOIT aboutir à l'état attendu (gardes satisfaites).
 */
const NOW = new Date('2026-07-16T10:00:00Z');

function snap(status: ContractStatus, over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    id: 'c1',
    type: 'MAIN',
    status,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2027-12-31'),
    noticePeriodDays: 30,
    currentVersionId: 'v1',
    approvedVersionId: 'v1',
    acceptedVersionId: 'v1',
    submittedByUserId: 'author',
    hasLsiSigner: true,
    hasClientSigner: true,
    hasRequiredAttachments: true,
    openAmendmentExists: false,
    hasSignedSuccessor: false,
    hasUnreviewedAiClauses: false,
    terminationEffectiveDate: new Date('2026-07-01'),
    ...over,
  };
}

/** Un événement VALIDE de chaque type (acteur ≠ auteur, motifs renseignés). */
const EVENTS: Record<ContractEventType, ContractEvent> = {
  SUBMIT_FOR_REVIEW: { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'author' },
  APPROVE: { type: 'APPROVE', actorUserId: 'reviewer' },
  REQUEST_CHANGES: { type: 'REQUEST_CHANGES', actorUserId: 'reviewer', reason: 'article 4' },
  EDIT_CONTENT: { type: 'EDIT_CONTENT', actorUserId: 'author' },
  SEND_TO_CLIENT: { type: 'SEND_TO_CLIENT', actorUserId: 'author' },
  CLIENT_ACCEPT: { type: 'CLIENT_ACCEPT', versionId: 'v1' },
  OPEN_NEGOTIATION: { type: 'OPEN_NEGOTIATION', actorUserId: 'author', reason: 'demande du client' },
  REOPEN_NEGOTIATION: { type: 'REOPEN_NEGOTIATION', actorUserId: 'author', reason: 'reprise' },
  SEND_FOR_SIGNATURE: { type: 'SEND_FOR_SIGNATURE', actorUserId: 'author' },
  REVOKE_SIGNATURE: { type: 'REVOKE_SIGNATURE', actorUserId: 'author' },
  SIGNER_SIGNED: { type: 'SIGNER_SIGNED', allSigned: true },
  SIGNER_DECLINED: { type: 'SIGNER_DECLINED', reason: 'prix' },
  SIGNATURE_EXPIRE: { type: 'SIGNATURE_EXPIRE' },
  ACTIVATE: { type: 'ACTIVATE' },
  VALIDATE_IMPORT: { type: 'VALIDATE_IMPORT', actorUserId: 'reviewer' },
  EXPIRE: { type: 'EXPIRE' },
  OPEN_RENEWAL: { type: 'OPEN_RENEWAL' },
  RENEW_PERIOD: { type: 'RENEW_PERIOD', newEndDate: new Date('2028-12-31') },
  CLOSE_RENEWAL: { type: 'CLOSE_RENEWAL', actorUserId: 'author', reason: 'décision reportée' },
  MARK_RENEWED: { type: 'MARK_RENEWED', successorContractId: 'c2' },
  CANCEL: { type: 'CANCEL', actorUserId: 'author', reason: 'abandon' },
  TERMINATE: {
    type: 'TERMINATE', actorUserId: 'author', reason: 'fin', isAdmin: false,
    effectiveDate: new Date('2026-09-01'),
  },
  COMPLETE_TERMINATION: { type: 'COMPLETE_TERMINATION' },
  WITHDRAW_TERMINATION: { type: 'WITHDRAW_TERMINATION', actorUserId: 'author', reason: 'rétractation' },
};

/** Surcharges du snapshot pour que les gardes d'un couple autorisé passent. */
const SETUP: Partial<Record<`${ContractStatus}:${ContractEventType}`, Partial<ContractSnapshot>>> = {
  'ACTIVE:EXPIRE': { endDate: new Date('2026-06-30') },
  'RENEWAL_DUE:EXPIRE': { endDate: new Date('2026-06-30') },
  'IMPORTED_PENDING_VALIDATION:VALIDATE_IMPORT': { approvedVersionId: null, acceptedVersionId: null },
  'SIGNATURE_EXPIRED:SEND_FOR_SIGNATURE': { acceptedVersionId: null },
};

/** Table §3 de 02-cycle-de-vie.md. */
const EXPECTED: Record<ContractStatus, Partial<Record<ContractEventType, ContractStatus>>> = {
  DRAFT: { EDIT_CONTENT: 'DRAFT', SUBMIT_FOR_REVIEW: 'IN_REVIEW', CANCEL: 'CANCELLED' },
  IN_REVIEW: { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', CANCEL: 'CANCELLED' },
  CHANGES_REQUESTED: { EDIT_CONTENT: 'CHANGES_REQUESTED', SUBMIT_FOR_REVIEW: 'IN_REVIEW', CANCEL: 'CANCELLED' },
  APPROVED: {
    EDIT_CONTENT: 'DRAFT', SEND_TO_CLIENT: 'SENT_TO_CLIENT', SEND_FOR_SIGNATURE: 'PENDING_SIGNATURE', CANCEL: 'CANCELLED',
  },
  SENT_TO_CLIENT: { CLIENT_ACCEPT: 'ACCEPTED', OPEN_NEGOTIATION: 'IN_NEGOTIATION', CANCEL: 'CANCELLED' },
  IN_NEGOTIATION: {
    EDIT_CONTENT: 'IN_NEGOTIATION', SUBMIT_FOR_REVIEW: 'IN_REVIEW', SEND_TO_CLIENT: 'SENT_TO_CLIENT', CANCEL: 'CANCELLED',
  },
  ACCEPTED: { SEND_FOR_SIGNATURE: 'PENDING_SIGNATURE', OPEN_NEGOTIATION: 'IN_NEGOTIATION', CANCEL: 'CANCELLED' },
  PENDING_SIGNATURE: {
    SIGNER_SIGNED: 'SIGNED', SIGNER_DECLINED: 'DECLINED', SIGNATURE_EXPIRE: 'SIGNATURE_EXPIRED',
    REVOKE_SIGNATURE: 'ACCEPTED', CANCEL: 'CANCELLED',
  },
  PARTIALLY_SIGNED: {
    SIGNER_SIGNED: 'SIGNED', SIGNER_DECLINED: 'DECLINED', SIGNATURE_EXPIRE: 'SIGNATURE_EXPIRED',
    REVOKE_SIGNATURE: 'ACCEPTED', CANCEL: 'CANCELLED',
  },
  DECLINED: { REOPEN_NEGOTIATION: 'IN_NEGOTIATION', CANCEL: 'CANCELLED' },
  SIGNATURE_EXPIRED: {
    REOPEN_NEGOTIATION: 'IN_NEGOTIATION', SEND_FOR_SIGNATURE: 'PENDING_SIGNATURE', CANCEL: 'CANCELLED',
  },
  SIGNED: { ACTIVATE: 'ACTIVE', TERMINATE: 'TERMINATION_PENDING' },
  ACTIVE: {
    EXPIRE: 'EXPIRED', TERMINATE: 'TERMINATION_PENDING', OPEN_RENEWAL: 'RENEWAL_DUE', MARK_RENEWED: 'RENEWED',
  },
  RENEWAL_DUE: {
    RENEW_PERIOD: 'ACTIVE', CLOSE_RENEWAL: 'ACTIVE', MARK_RENEWED: 'RENEWED', EXPIRE: 'EXPIRED',
    TERMINATE: 'TERMINATION_PENDING',
  },
  TERMINATION_PENDING: { COMPLETE_TERMINATION: 'TERMINATED', WITHDRAW_TERMINATION: 'ACTIVE' },
  EXPIRED: { MARK_RENEWED: 'RENEWED' },
  IMPORTED_PENDING_VALIDATION: { VALIDATE_IMPORT: 'ACTIVE', CANCEL: 'CANCELLED' },
  TERMINATED: {},
  RENEWED: {},
  CANCELLED: {},
};

describe('matrice exhaustive états × événements (02-cycle-de-vie §3)', () => {
  test('la table couvre tous les statuts', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CONTRACT_STATUSES].sort());
  });

  for (const status of CONTRACT_STATUSES) {
    for (const type of Object.keys(EVENTS) as ContractEventType[]) {
      const target = EXPECTED[status][type];
      if (target) {
        test(`${status} --${type}--> ${target}`, () => {
          const r = applyEvent(snap(status, SETUP[`${status}:${type}`]), EVENTS[type], NOW);
          expect(r.status).toBe(target);
        });
      } else {
        test(`${status} --${type}--> interdit`, () => {
          expect(() => applyEvent(snap(status), EVENTS[type], NOW)).toThrow(InvalidTransitionError);
        });
      }
    }
  }

  test('terminaux : TERMINATED, RENEWED, CANCELLED — et DECLINED ne l’est plus', () => {
    expect(CONTRACT_STATUSES.filter(isTerminal).sort()).toEqual(['CANCELLED', 'RENEWED', 'TERMINATED']);
  });
});

describe('acceptation distincte de la signature', () => {
  test('SEND_TO_CLIENT exige que la version courante soit la version validée', () => {
    expect(() =>
      applyEvent(snap('APPROVED', { currentVersionId: 'v2', approvedVersionId: 'v1' }), EVENTS.SEND_TO_CLIENT, NOW),
    ).toThrow(BusinessRuleError);
  });

  test('CLIENT_ACCEPT fige la version acceptée', () => {
    const r = applyEvent(snap('SENT_TO_CLIENT', { acceptedVersionId: null }), EVENTS.CLIENT_ACCEPT, NOW);
    expect(r.acceptedVersionId).toBe('v1');
  });

  test('accepter une autre version que la version présentée est refusé', () => {
    expect(() =>
      applyEvent(snap('SENT_TO_CLIENT'), { type: 'CLIENT_ACCEPT', versionId: 'v0' }, NOW),
    ).toThrow(/version/i);
  });

  test('depuis ACCEPTED, envoyer en signature une version différente de celle acceptée est refusé', () => {
    expect(() =>
      applyEvent(snap('ACCEPTED', { currentVersionId: 'v2', approvedVersionId: 'v2', acceptedVersionId: 'v1' }),
        EVENTS.SEND_FOR_SIGNATURE, NOW),
    ).toThrow(BusinessRuleError);
  });

  test('la négociation efface l’acceptation et, à l’édition, la validation', () => {
    const neg = applyEvent(snap('ACCEPTED'), EVENTS.OPEN_NEGOTIATION, NOW);
    expect(neg.acceptedVersionId).toBeNull();
    const edited = applyEvent({ ...neg, currentVersionId: 'v2' }, EVENTS.EDIT_CONTENT, NOW);
    expect(edited).toMatchObject({ status: 'IN_NEGOTIATION', approvedVersionId: null });
    // …donc le renvoi au client exige une nouvelle validation interne.
    expect(() => applyEvent(edited, EVENTS.SEND_TO_CLIENT, NOW)).toThrow(BusinessRuleError);
  });

  test('ouvrir une négociation exige un motif', () => {
    expect(() =>
      applyEvent(snap('SENT_TO_CLIENT'), { type: 'OPEN_NEGOTIATION', actorUserId: 'a', reason: '  ' }, NOW),
    ).toThrow(BusinessRuleError);
  });
});

describe('verrouillage et signature', () => {
  test('aucune édition en signature : il faut révoquer', () => {
    for (const s of ['PENDING_SIGNATURE', 'PARTIALLY_SIGNED'] as const) {
      expect(() => applyEvent(snap(s), EVENTS.EDIT_CONTENT, NOW)).toThrow(InvalidTransitionError);
    }
  });

  test('révoquer une signature non précédée d’acceptation ramène à APPROVED', () => {
    const r = applyEvent(snap('PENDING_SIGNATURE', { acceptedVersionId: null }), EVENTS.REVOKE_SIGNATURE, NOW);
    expect(r.status).toBe('APPROVED');
  });

  test('signature partielle', () => {
    const r = applyEvent(snap('PENDING_SIGNATURE'), { type: 'SIGNER_SIGNED', allSigned: false }, NOW);
    expect(r.status).toBe('PARTIALLY_SIGNED');
  });

  test('refus puis reprise de la négociation, motif obligatoire', () => {
    const declined = applyEvent(snap('PENDING_SIGNATURE'), EVENTS.SIGNER_DECLINED, NOW);
    expect(declined.status).toBe('DECLINED');
    expect(() =>
      applyEvent(declined, { type: 'REOPEN_NEGOTIATION', actorUserId: 'a', reason: '' }, NOW),
    ).toThrow(BusinessRuleError);
    expect(applyEvent(declined, EVENTS.REOPEN_NEGOTIATION, NOW)).toMatchObject({
      status: 'IN_NEGOTIATION', acceptedVersionId: null,
    });
  });

  test('renvoi en signature après expiration : même garde de version validée', () => {
    expect(() =>
      applyEvent(snap('SIGNATURE_EXPIRED', { currentVersionId: 'v2', approvedVersionId: 'v1', acceptedVersionId: null }),
        EVENTS.SEND_FOR_SIGNATURE, NOW),
    ).toThrow(BusinessRuleError);
  });
});

describe('variables du contrat type', () => {
  test('ne peut être soumis tant qu’une variable reste à compléter', () => {
    expect(() =>
      applyEvent(snap('DRAFT', { hasMissingVariables: true, approvedVersionId: null }), EVENTS.SUBMIT_FOR_REVIEW, NOW),
    ).toThrow(/à compléter/);
    expect(allowedEvents(snap('DRAFT', { hasMissingVariables: true }))).not.toContain('SUBMIT_FOR_REVIEW');
  });
});

describe('contrat rédigé par IA', () => {
  test('ne peut être soumis tant qu’une clause IA n’est pas validée', () => {
    expect(() =>
      applyEvent(snap('DRAFT', { hasUnreviewedAiClauses: true, approvedVersionId: null }), EVENTS.SUBMIT_FOR_REVIEW, NOW),
    ).toThrow(/IA/);
  });
});

describe('résiliation', () => {
  test('date d’effet future → TERMINATION_PENDING avec la date retenue', () => {
    const r = applyEvent(snap('ACTIVE'), EVENTS.TERMINATE, NOW);
    expect(r).toMatchObject({ status: 'TERMINATION_PENDING', terminationEffectiveDate: new Date('2026-09-01') });
  });

  test('date d’effet atteinte (dérogation admin) → TERMINATED immédiatement', () => {
    const r = applyEvent(
      snap('ACTIVE', { noticePeriodDays: 0 }),
      { ...EVENTS.TERMINATE, effectiveDate: new Date('2026-07-16') } as ContractEvent,
      NOW,
    );
    expect(r.status).toBe('TERMINATED');
    expect(r.terminatedAt).toEqual(NOW);
  });

  test('COMPLETE_TERMINATION refusée avant la date d’effet', () => {
    expect(() =>
      applyEvent(snap('TERMINATION_PENDING', { terminationEffectiveDate: new Date('2026-09-01') }),
        EVENTS.COMPLETE_TERMINATION, NOW),
    ).toThrow(BusinessRuleError);
  });

  test('retrait d’une résiliation : motif obligatoire, date d’effet effacée', () => {
    expect(() =>
      applyEvent(snap('TERMINATION_PENDING'), { type: 'WITHDRAW_TERMINATION', actorUserId: 'a', reason: '' }, NOW),
    ).toThrow(BusinessRuleError);
    const r = applyEvent(snap('TERMINATION_PENDING'), EVENTS.WITHDRAW_TERMINATION, NOW);
    expect(r).toMatchObject({ status: 'ACTIVE', terminationEffectiveDate: null });
  });

  test('préavis non respecté sans dérogation → refus (RM-20 inchangée)', () => {
    expect(() =>
      applyEvent(snap('ACTIVE', { noticePeriodDays: 90 }), EVENTS.TERMINATE, NOW),
    ).toThrow(/préavis/);
  });
});

describe('renouvellement', () => {
  test('RENEW_PERIOD avance le terme', () => {
    const r = applyEvent(snap('RENEWAL_DUE'), EVENTS.RENEW_PERIOD, NOW);
    expect(r).toMatchObject({ status: 'ACTIVE', endDate: new Date('2028-12-31') });
  });

  test('RENEW_PERIOD refuse un terme qui ne prolonge pas le contrat', () => {
    expect(() =>
      applyEvent(snap('RENEWAL_DUE'), { type: 'RENEW_PERIOD', newEndDate: new Date('2027-06-30') }, NOW),
    ).toThrow(BusinessRuleError);
  });

  test('OPEN_RENEWAL exige un terme (un contrat à durée indéterminée ne se renouvelle pas)', () => {
    expect(() => applyEvent(snap('ACTIVE', { endDate: null }), EVENTS.OPEN_RENEWAL, NOW)).toThrow(BusinessRuleError);
  });
});

describe('import d’un contrat existant', () => {
  const imported = (over: Partial<ContractSnapshot>) =>
    snap('IMPORTED_PENDING_VALIDATION', { approvedVersionId: null, acceptedVersionId: null, ...over });

  test('en cours → ACTIVE, sans passer par la signature', () => {
    const r = applyEvent(imported({}), EVENTS.VALIDATE_IMPORT, NOW);
    expect(r).toMatchObject({ status: 'ACTIVE', activatedAt: NOW });
  });

  test('effet futur → SIGNED (l’activation suivra à la date d’effet)', () => {
    const r = applyEvent(imported({ startDate: new Date('2026-10-01') }), EVENTS.VALIDATE_IMPORT, NOW);
    expect(r.status).toBe('SIGNED');
  });

  test('terme dépassé → EXPIRED (un import historique reste consultable)', () => {
    const r = applyEvent(imported({ endDate: new Date('2025-12-31') }), EVENTS.VALIDATE_IMPORT, NOW);
    expect(r.status).toBe('EXPIRED');
  });

  test('date d’effet manquante → refus', () => {
    expect(() => applyEvent(imported({ startDate: null }), EVENTS.VALIDATE_IMPORT, NOW)).toThrow(BusinessRuleError);
  });
});

describe('allowedEvents reflète les gardes', () => {
  test('SEND_TO_CLIENT n’est proposé que si la version courante est validée', () => {
    expect(allowedEvents(snap('APPROVED'))).toContain('SEND_TO_CLIENT');
    expect(allowedEvents(snap('APPROVED', { currentVersionId: 'v2' }))).not.toContain('SEND_TO_CLIENT');
  });

  test('COMPLETE_TERMINATION n’est proposé qu’à la date d’effet', () => {
    expect(allowedEvents(snap('TERMINATION_PENDING', { terminationEffectiveDate: new Date('2026-09-01') }), NOW))
      .not.toContain('COMPLETE_TERMINATION');
    expect(allowedEvents(snap('TERMINATION_PENDING', { terminationEffectiveDate: new Date('2026-07-01') }), NOW))
      .toContain('COMPLETE_TERMINATION');
  });
});

describe('TERMINATE — date due fournie (minEffectiveDate)', () => {
  const due = new Date('2026-12-31');
  const ev = (effectiveDate: Date, isAdmin = false, overrideReason?: string) => ({
    type: 'TERMINATE' as const, actorUserId: 'u', reason: 'fin', effectiveDate, isAdmin, minEffectiveDate: due,
    ...(overrideReason ? { overrideReason } : {}),
  });

  test('à la date due ou après : accepté sans dérogation', () => {
    expect(applyEvent(snap('ACTIVE', { noticePeriodDays: 30 }), ev(due), NOW).status).toBe('TERMINATION_PENDING');
  });

  test('avant la date due, même au-delà du préavis en jours : dérogation exigée', () => {
    expect(() => applyEvent(snap('ACTIVE', { noticePeriodDays: 30 }), ev(new Date('2026-10-01')), NOW)).toThrow(/2026-12-31/);
    expect(() => applyEvent(snap('ACTIVE', { noticePeriodDays: 30 }), ev(new Date('2026-10-01'), true), NOW)).toThrow(/justification/);
    expect(applyEvent(snap('ACTIVE', { noticePeriodDays: 30 }), ev(new Date('2026-10-01'), true, 'accord'), NOW).status).toBe('TERMINATION_PENDING');
  });
});
