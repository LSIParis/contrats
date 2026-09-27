import { describe, test, expect } from 'vitest';
import {
  applyProposalEvent,
  allowedProposalEvents,
  ProposalTransitionError,
  ProposalRuleError,
  isProposalTerminal,
} from '../src/proposal/state-machine.js';
import {
  PROPOSAL_STATUSES,
  PROPOSAL_EVENT_TYPES,
  type ProposalEvent,
  type ProposalEventType,
  type ProposalSnapshot,
  type ProposalStatus,
} from '../src/proposal/proposal.types.js';

/**
 * Machine à états de la proposition — docs/contrats/11-propositions.md §3.
 *
 * EXPECTED est la table du §3 recopiée à la main : le test exhaustif vérifie
 * les 13 états × 20 événements. Tout couple absent DOIT lever
 * ProposalTransitionError ; tout couple présent DOIT aboutir à l'état attendu
 * (gardes satisfaites).
 */
const NOW = new Date('2026-10-01T10:00:00Z');
const LATER = new Date('2026-10-31T00:00:00Z');
const EARLIER = new Date('2026-09-01T00:00:00Z');

function snap(status: ProposalStatus, over: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    id: 'p1',
    status,
    currentVersionId: 'v1',
    acceptanceMode: 'DOCUSEAL_SIGNATURE',
    expiresAt: LATER,
    reviewRequired: false,
    reviewSubmittedByUserId: 'author',
    reviewApprovedVersionId: null,
    acceptedVersionId: null,
    hasRecipients: true,
    hasSigner: true,
    unresolvedMergeTags: 0,
    blockingValidations: 0,
    pricingErrors: 0,
    ...over,
  };
}

function eventOf(type: ProposalEventType): ProposalEvent {
  switch (type) {
    case 'SUBMIT_FOR_REVIEW':
    case 'MARK_READY':
      return { type, actorUserId: 'author' };
    case 'APPROVE_REVIEW':
      return { type, actorUserId: 'reviewer' };
    case 'REJECT_REVIEW':
      return { type, actorUserId: 'reviewer', reason: 'Remise trop élevée' };
    case 'SEND':
      return { type, expiresAt: LATER };
    case 'ACCEPT':
      return { type, versionId: 'v1' };
    case 'SIGNATURE_DECLINED':
      return { type, reason: 'Refus du signataire' };
    case 'CONVERT':
      return { type, contractId: 'c1' };
    case 'DECLINE':
      return { type, reasonCode: 'PRICE', reason: 'Trop cher' };
    case 'WITHDRAW':
      return { type, reason: 'Projet abandonné' };
    case 'REACTIVATE':
      return { type, expiresAt: LATER, reason: 'Relance du client' };
    case 'REVISE':
      return { type, reason: 'Ajout d’une option' };
    default:
      return { type } as ProposalEvent;
  }
}

/** Snapshot qui satisfait les gardes de l'événement dans cet état. */
function snapFor(status: ProposalStatus, type: ProposalEventType): ProposalSnapshot {
  if (type === 'EXPIRE') return snap(status, { expiresAt: EARLIER });
  if (type === 'COMPLETE_CLICK_ACCEPT') return snap(status, { acceptanceMode: 'CLICK_ACCEPT' });
  if (type === 'START_SIGNATURE') return snap(status, { acceptedVersionId: 'v1' });
  return snap(status);
}

const EXPECTED: Record<ProposalStatus, Partial<Record<ProposalEventType, ProposalStatus>>> = {
  DRAFT: { SUBMIT_FOR_REVIEW: 'IN_INTERNAL_REVIEW', MARK_READY: 'READY' },
  IN_INTERNAL_REVIEW: { APPROVE_REVIEW: 'READY', REJECT_REVIEW: 'DRAFT' },
  READY: { SEND: 'SENT', REVISE: 'DRAFT' },
  SENT: { VIEW: 'VIEWED', EXPIRE: 'EXPIRED', DECLINE: 'DECLINED', WITHDRAW: 'WITHDRAWN', REVISE: 'DRAFT' },
  VIEWED: {
    OPEN_DISCUSSION: 'IN_DISCUSSION', ACCEPT: 'ACCEPTED', EXPIRE: 'EXPIRED', DECLINE: 'DECLINED',
    WITHDRAW: 'WITHDRAWN', REVISE: 'DRAFT',
  },
  IN_DISCUSSION: {
    CLOSE_DISCUSSION: 'VIEWED', ACCEPT: 'ACCEPTED', EXPIRE: 'EXPIRED', DECLINE: 'DECLINED',
    WITHDRAW: 'WITHDRAWN', REVISE: 'DRAFT',
  },
  ACCEPTED: { START_SIGNATURE: 'PENDING_SIGNATURE', COMPLETE_CLICK_ACCEPT: 'SIGNED', REVISE: 'DRAFT' },
  PENDING_SIGNATURE: {
    SIGNATURE_COMPLETED: 'SIGNED', SIGNATURE_DECLINED: 'IN_DISCUSSION', SIGNATURE_EXPIRED: 'IN_DISCUSSION',
  },
  SIGNED: { CONVERT: 'CONVERTED' },
  EXPIRED: { REACTIVATE: 'READY' },
  CONVERTED: {},
  DECLINED: {},
  WITHDRAWN: {},
};

describe('matrice exhaustive états × événements', () => {
  for (const status of PROPOSAL_STATUSES) {
    for (const type of PROPOSAL_EVENT_TYPES) {
      const expected = EXPECTED[status][type];
      test(`${status} + ${type} → ${expected ?? 'refus'}`, () => {
        const s = snapFor(status, type);
        if (expected) {
          expect(applyProposalEvent(s, eventOf(type), NOW).status).toBe(expected);
        } else {
          expect(() => applyProposalEvent(s, eventOf(type), NOW)).toThrow(ProposalTransitionError);
        }
      });
    }
  }

  test('états terminaux', () => {
    expect(PROPOSAL_STATUSES.filter(isProposalTerminal)).toEqual(['CONVERTED', 'DECLINED', 'WITHDRAWN']);
  });

  test('allowedProposalEvents ne propose que des transitions réalisables', () => {
    expect(allowedProposalEvents(snap('VIEWED'), NOW)).toEqual(
      expect.arrayContaining(['ACCEPT', 'OPEN_DISCUSSION', 'DECLINE', 'WITHDRAW', 'REVISE']),
    );
    // Échéance non atteinte : EXPIRE n'est pas proposé.
    expect(allowedProposalEvents(snap('VIEWED'), NOW)).not.toContain('EXPIRE');
    // Expirée à la date : ACCEPT n'est plus proposé.
    expect(allowedProposalEvents(snap('VIEWED', { expiresAt: EARLIER }), NOW)).not.toContain('ACCEPT');
  });
});

describe('gardes de préparation (PRÊTE)', () => {
  test('un élément TO_VALIDATE interdit le passage à PRÊTE', () => {
    expect(() => applyProposalEvent(snap('DRAFT', { blockingValidations: 2 }), eventOf('MARK_READY'), NOW))
      .toThrow(/à valider/);
  });

  test('une balise de fusion non résolue interdit le passage à PRÊTE et la revue', () => {
    expect(() => applyProposalEvent(snap('DRAFT', { unresolvedMergeTags: 1 }), eventOf('MARK_READY'), NOW))
      .toThrow(ProposalRuleError);
    expect(() => applyProposalEvent(snap('DRAFT', { unresolvedMergeTags: 1 }), eventOf('SUBMIT_FOR_REVIEW'), NOW))
      .toThrow(/balise/);
  });

  test('un tableau de prix incalculable interdit le passage à PRÊTE', () => {
    expect(() => applyProposalEvent(snap('DRAFT', { pricingErrors: 1 }), eventOf('MARK_READY'), NOW))
      .toThrow(/tableau de prix/);
  });

  test('sans destinataire ou sans signataire : refus', () => {
    expect(() => applyProposalEvent(snap('DRAFT', { hasRecipients: false }), eventOf('MARK_READY'), NOW)).toThrow(/destinataire/);
    expect(() => applyProposalEvent(snap('DRAFT', { hasSigner: false }), eventOf('MARK_READY'), NOW)).toThrow(/signataire/);
  });

  test('revue interne obligatoire : MARK_READY refusé, la revue passe', () => {
    const s = snap('DRAFT', { reviewRequired: true });
    expect(() => applyProposalEvent(s, eventOf('MARK_READY'), NOW)).toThrow(/revue interne/i);
    const inReview = applyProposalEvent(s, eventOf('SUBMIT_FOR_REVIEW'), NOW);
    expect(inReview).toMatchObject({ status: 'IN_INTERNAL_REVIEW', reviewSubmittedByUserId: 'author' });
    const ready = applyProposalEvent(inReview, eventOf('APPROVE_REVIEW'), NOW);
    expect(ready).toMatchObject({ status: 'READY', reviewApprovedVersionId: 'v1' });
  });

  test('le valideur ne peut pas être l’auteur de la soumission', () => {
    const s = snap('IN_INTERNAL_REVIEW', { reviewSubmittedByUserId: 'reviewer' });
    expect(() => applyProposalEvent(s, eventOf('APPROVE_REVIEW'), NOW)).toThrow(/autre personne/);
    expect(() => applyProposalEvent(s, eventOf('REJECT_REVIEW'), NOW)).toThrow(/autre personne/);
  });

  test('la validation revérifie les gardes (un prix redevenu à valider bloque)', () => {
    const s = snap('IN_INTERNAL_REVIEW', { blockingValidations: 1 });
    expect(() => applyProposalEvent(s, eventOf('APPROVE_REVIEW'), NOW)).toThrow(ProposalRuleError);
  });
});

describe('envoi, expiration, réactivation', () => {
  test('SEND fixe la date d’expiration, qui doit être future', () => {
    expect(applyProposalEvent(snap('READY', { expiresAt: null }), eventOf('SEND'), NOW).expiresAt).toEqual(LATER);
    expect(() => applyProposalEvent(snap('READY'), { type: 'SEND', expiresAt: EARLIER }, NOW)).toThrow(/future/);
  });

  test('EXPIRE exige une échéance atteinte', () => {
    expect(() => applyProposalEvent(snap('SENT'), eventOf('EXPIRE'), NOW)).toThrow(/échéance/);
  });

  test('REACTIVATE : nouvelle date future et motif obligatoires', () => {
    const s = snap('EXPIRED', { expiresAt: EARLIER });
    expect(() => applyProposalEvent(s, { type: 'REACTIVATE', expiresAt: EARLIER, reason: 'x' }, NOW)).toThrow(/future/);
    expect(() => applyProposalEvent(s, { type: 'REACTIVATE', expiresAt: LATER, reason: ' ' }, NOW)).toThrow(/motif/);
    expect(applyProposalEvent(s, eventOf('REACTIVATE'), NOW)).toMatchObject({ status: 'READY', expiresAt: LATER });
  });

  test('DECLINE et WITHDRAW exigent un motif', () => {
    expect(() => applyProposalEvent(snap('VIEWED'), { type: 'DECLINE', reasonCode: '', reason: '' }, NOW)).toThrow(/motif/);
    expect(() => applyProposalEvent(snap('SENT'), { type: 'WITHDRAW', reason: '' }, NOW)).toThrow(/motif/);
  });
});

describe('acceptation : version courante et non expirée uniquement', () => {
  test('une version remplacée ne peut pas être acceptée', () => {
    expect(() => applyProposalEvent(snap('VIEWED'), { type: 'ACCEPT', versionId: 'v0' }, NOW)).toThrow(/remplacée/);
  });

  test('une proposition dont l’échéance est passée ne peut pas être acceptée', () => {
    const s = snap('VIEWED', { expiresAt: EARLIER });
    expect(() => applyProposalEvent(s, eventOf('ACCEPT'), NOW)).toThrow(/expirée/);
  });

  test('une proposition expirée ne peut pas partir en signature', () => {
    const s = snap('ACCEPTED', { acceptedVersionId: 'v1', expiresAt: EARLIER });
    expect(() => applyProposalEvent(s, eventOf('START_SIGNATURE'), NOW)).toThrow(/expirée/);
  });

  test('ACCEPT retient la version acceptée', () => {
    expect(applyProposalEvent(snap('IN_DISCUSSION'), eventOf('ACCEPT'), NOW).acceptedVersionId).toBe('v1');
  });

  test('mode d’acceptation : signature DocuSeal ou clic, jamais l’autre voie', () => {
    const click = snap('ACCEPTED', { acceptanceMode: 'CLICK_ACCEPT', acceptedVersionId: 'v1' });
    expect(() => applyProposalEvent(click, eventOf('START_SIGNATURE'), NOW)).toThrow(/CLICK_ACCEPT/);
    const sign = snap('ACCEPTED', { acceptedVersionId: 'v1' });
    expect(() => applyProposalEvent(sign, eventOf('COMPLETE_CLICK_ACCEPT'), NOW)).toThrow(/DOCUSEAL_SIGNATURE/);
  });

  test('REVISE efface la validation interne et l’acceptation', () => {
    const s = snap('ACCEPTED', { reviewApprovedVersionId: 'v1', acceptedVersionId: 'v1' });
    expect(applyProposalEvent(s, eventOf('REVISE'), NOW)).toMatchObject({
      status: 'DRAFT', reviewApprovedVersionId: null, acceptedVersionId: null,
    });
  });
});
