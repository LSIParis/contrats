import { describe, test, expect } from 'vitest';
import {
  applyEvent,
  allowedEvents,
  InvalidTransitionError,
  BusinessRuleError,
} from '../src/contract/state-machine.js';
import type { ContractSnapshot } from '../src/contract/contract.types.js';

const TODAY = new Date('2026-07-16T10:00:00Z');

/** Un contrat prêt à être soumis : toutes les gardes de §7.3 satisfaites. */
function draft(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    id: 'c1',
    type: 'MAIN',
    status: 'DRAFT',
    startDate: new Date('2026-09-01'),
    endDate: new Date('2027-08-31'),
    noticePeriodDays: 90,
    currentVersionId: 'v1',
    approvedVersionId: null,
    submittedByUserId: null,
    hasLsiSigner: true,
    hasClientSigner: true,
    hasRequiredAttachments: true,
    openAmendmentExists: false,
    hasSignedSuccessor: false,
    ...over,
  };
}

// ===========================================================================
// §7.2 — matrice de transitions
// ===========================================================================

describe('cycle nominal', () => {
  test('DRAFT → IN_REVIEW', () => {
    const r = applyEvent(draft(), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, TODAY);
    expect(r.status).toBe('IN_REVIEW');
    expect(r.submittedByUserId).toBe('u1');
  });

  test('IN_REVIEW → APPROVED fige la version validée', () => {
    const c = draft({ status: 'IN_REVIEW', submittedByUserId: 'u1' });
    const r = applyEvent(c, { type: 'APPROVE', actorUserId: 'u2' }, TODAY);
    expect(r.status).toBe('APPROVED');
    // RM-11 : une validation porte sur une VERSION, jamais sur un contrat.
    expect(r.approvedVersionId).toBe('v1');
  });

  test('APPROVED → PENDING_SIGNATURE', () => {
    const c = draft({ status: 'APPROVED', approvedVersionId: 'v1', submittedByUserId: 'u1' });
    const r = applyEvent(c, { type: 'SEND_FOR_SIGNATURE', actorUserId: 'u1' }, TODAY);
    expect(r.status).toBe('PENDING_SIGNATURE');
  });

  test('PENDING_SIGNATURE → PARTIALLY_SIGNED puis SIGNED', () => {
    const c = draft({ status: 'PENDING_SIGNATURE' });
    const partial = applyEvent(c, { type: 'SIGNER_SIGNED', allSigned: false }, TODAY);
    expect(partial.status).toBe('PARTIALLY_SIGNED');

    const signed = applyEvent(partial, { type: 'SIGNER_SIGNED', allSigned: true }, TODAY);
    expect(signed.status).toBe('SIGNED');
    expect(signed.signedAt).toEqual(TODAY);
  });
});

describe('RM-06 — activation liée à start_date', () => {
  test('SIGNED reste SIGNED si start_date est future', () => {
    const c = draft({ status: 'SIGNED', startDate: new Date('2026-09-01') });
    const r = applyEvent(c, { type: 'ACTIVATE' }, TODAY); // TODAY = 16/07
    expect(r.status).toBe('SIGNED');
  });

  test('SIGNED → ACTIVE quand start_date est atteinte', () => {
    const c = draft({ status: 'SIGNED', startDate: new Date('2026-07-01') });
    const r = applyEvent(c, { type: 'ACTIVATE' }, TODAY);
    expect(r.status).toBe('ACTIVE');
    expect(r.activatedAt).toEqual(TODAY);
  });
});

// ===========================================================================
// §7.3 — gardes
// ===========================================================================

describe('RM-12 — signataires obligatoires', () => {
  test('soumettre sans signataire client échoue', () => {
    expect(() =>
      applyEvent(draft({ hasClientSigner: false }), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, TODAY),
    ).toThrow(BusinessRuleError);
  });

  test('soumettre sans signataire LSI échoue', () => {
    expect(() =>
      applyEvent(draft({ hasLsiSigner: false }), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, TODAY),
    ).toThrow(/signataire/i);
  });
});

describe('EC-11 — les pièces jointes obligatoires bloquent TÔT', () => {
  test('soumettre sans pièce jointe obligatoire échoue', () => {
    // Le blocage est à la soumission, pas à l'envoi : l'erreur doit
    // arriver avant que le juriste ait perdu son temps.
    expect(() =>
      applyEvent(
        draft({ hasRequiredAttachments: false }),
        { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' },
        TODAY,
      ),
    ).toThrow(/pièce/i);
  });
});

describe('RM-10 — séparation des tâches', () => {
  test('le soumettant ne peut pas valider son propre contrat', () => {
    const c = draft({ status: 'IN_REVIEW', submittedByUserId: 'u1' });
    expect(() => applyEvent(c, { type: 'APPROVE', actorUserId: 'u1' }, TODAY)).toThrow(
      /soumis/i,
    );
  });
});

describe('RM-11 — une validation porte sur une version', () => {
  test('envoyer en signature après modification de la version échoue', () => {
    const c = draft({ status: 'APPROVED', approvedVersionId: 'v1', currentVersionId: 'v2' });
    expect(() => applyEvent(c, { type: 'SEND_FOR_SIGNATURE', actorUserId: 'u1' }, TODAY)).toThrow(
      /validation/i,
    );
  });

  test('éditer un contrat APPROVED le renvoie en DRAFT et invalide la validation', () => {
    const c = draft({ status: 'APPROVED', approvedVersionId: 'v1' });
    const r = applyEvent(c, { type: 'EDIT_CONTENT', actorUserId: 'u1' }, TODAY);
    expect(r.status).toBe('DRAFT');
    expect(r.approvedVersionId).toBeNull();
  });
});

describe('RM-09 — pas de raccourci vers la signature', () => {
  test('DRAFT → PENDING_SIGNATURE est impossible, même pour un admin', () => {
    expect(() => applyEvent(draft(), { type: 'SEND_FOR_SIGNATURE', actorUserId: 'u1' }, TODAY)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('RM-05 — un contrat signé est immuable', () => {
  test.each(['SIGNED', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const)(
    'éditer un contrat %s est rejeté',
    (status) => {
      expect(() =>
        applyEvent(draft({ status }), { type: 'EDIT_CONTENT', actorUserId: 'u1' }, TODAY),
      ).toThrow(InvalidTransitionError);
    },
  );
});

// ===========================================================================
// Cas réels — §4.2
// ===========================================================================

describe('EC-10 — un signataire refuse', () => {
  test('PENDING_SIGNATURE → DECLINED avec motif', () => {
    const c = draft({ status: 'PENDING_SIGNATURE' });
    const r = applyEvent(c, { type: 'SIGNER_DECLINED', reason: 'Tarif trop élevé' }, TODAY);
    expect(r.status).toBe('DECLINED');
  });

  test('un contrat DECLINED est terminal — pas de réouverture silencieuse', () => {
    const c = draft({ status: 'DECLINED' });
    expect(() => applyEvent(c, { type: 'SEND_FOR_SIGNATURE', actorUserId: 'u1' }, TODAY)).toThrow(
      InvalidTransitionError,
    );
    expect(allowedEvents(c)).toEqual([]);
  });
});

describe('RM-22 / EC-09 — annulation', () => {
  test.each(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PENDING_SIGNATURE', 'PARTIALLY_SIGNED'] as const)(
    'annuler depuis %s est autorisé',
    (status) => {
      const r = applyEvent(draft({ status }), { type: 'CANCEL', actorUserId: 'u1', reason: 'x' }, TODAY);
      expect(r.status).toBe('CANCELLED');
    },
  );

  test('annuler un contrat SIGNED est impossible — seule la résiliation existe', () => {
    expect(() =>
      applyEvent(draft({ status: 'SIGNED' }), { type: 'CANCEL', actorUserId: 'u1', reason: 'x' }, TODAY),
    ).toThrow(InvalidTransitionError);
  });

  test('CANCELLED est terminal', () => {
    expect(allowedEvents(draft({ status: 'CANCELLED' }))).toEqual([]);
  });
});

describe('RM-20 — résiliation et préavis', () => {
  test('résilier en respectant le préavis est autorisé', () => {
    const c = draft({ status: 'ACTIVE', noticePeriodDays: 90 });
    const r = applyEvent(
      c,
      { type: 'TERMINATE', actorUserId: 'u1', reason: 'fin', effectiveDate: new Date('2026-11-01'), isAdmin: false },
      TODAY,
    );
    expect(r.status).toBe('TERMINATED');
  });

  test('résilier sans respecter le préavis est REFUSÉ à un account manager', () => {
    const c = draft({ status: 'ACTIVE', noticePeriodDays: 90 });
    expect(() =>
      applyEvent(
        c,
        { type: 'TERMINATE', actorUserId: 'u1', reason: 'fin', effectiveDate: new Date('2026-08-01'), isAdmin: false },
        TODAY,
      ),
    ).toThrow(/préavis/i);
  });

  test('la frontière exacte (aujourd\'hui + préavis) est ACCEPTÉE pour un non-admin', () => {
    // TODAY = 2026-07-16T10:00:00Z (heure de jour non nulle) + 90 jours de
    // préavis ⇒ frontière = 2026-10-14 (minuit UTC). La comparaison doit
    // porter sur des JOURS, pas des instants : sinon minuit < 10h et la
    // date pile au bord du préavis est refusée à tort (régression).
    const c = draft({ status: 'ACTIVE', noticePeriodDays: 90 });
    const r = applyEvent(
      c,
      { type: 'TERMINATE', actorUserId: 'u1', reason: 'fin', effectiveDate: new Date('2026-10-14'), isAdmin: false },
      TODAY,
    );
    expect(r.status).toBe('TERMINATED');
  });

  test('un MSP_ADMIN peut déroger, mais seulement avec une justification', () => {
    const c = draft({ status: 'ACTIVE', noticePeriodDays: 90 });
    expect(() =>
      applyEvent(
        c,
        { type: 'TERMINATE', actorUserId: 'u1', reason: 'fin', effectiveDate: new Date('2026-08-01'), isAdmin: true },
        TODAY,
      ),
    ).toThrow(/justification/i);

    const r = applyEvent(
      c,
      {
        type: 'TERMINATE',
        actorUserId: 'u1',
        reason: 'fin',
        effectiveDate: new Date('2026-08-01'),
        isAdmin: true,
        overrideReason: 'Accord commercial acté par le dirigeant',
      },
      TODAY,
    );
    expect(r.status).toBe('TERMINATED');
  });
});

describe('EC-07 / RM-19 — avenant', () => {
  test('un avenant sur contrat ACTIVE est autorisé', () => {
    expect(() => assertCanAmend(draft({ status: 'ACTIVE' }))).not.toThrow();
  });

  test('un second avenant en cours est refusé', () => {
    expect(() => assertCanAmend(draft({ status: 'ACTIVE', openAmendmentExists: true }))).toThrow(
      /avenant/i,
    );
  });

  test('un avenant sur un contrat DRAFT est refusé — il suffit de l’éditer', () => {
    expect(() => assertCanAmend(draft({ status: 'DRAFT' }))).toThrow();
  });
});

describe('RM-07 / §7.2 — expiration et renouvellement', () => {
  test('ACTIVE → EXPIRED au terme', () => {
    const c = draft({ status: 'ACTIVE', endDate: new Date('2026-07-15') });
    const r = applyEvent(c, { type: 'EXPIRE' }, TODAY);
    expect(r.status).toBe('EXPIRED');
  });

  test('ACTIVE au terme AVEC successeur signé → RENEWED, pas EXPIRED', () => {
    const c = draft({ status: 'ACTIVE', endDate: new Date('2026-07-15'), hasSignedSuccessor: true });
    const r = applyEvent(c, { type: 'EXPIRE' }, TODAY);
    expect(r.status).toBe('RENEWED');
  });

  test('EXPIRED → RENEWED reste possible (renouvellement tardif rétroactif)', () => {
    const c = draft({ status: 'EXPIRED' });
    const r = applyEvent(c, { type: 'MARK_RENEWED', successorContractId: 'c2' }, TODAY);
    expect(r.status).toBe('RENEWED');
  });

  test('un contrat pas encore au terme ne peut pas expirer', () => {
    const c = draft({ status: 'ACTIVE', endDate: new Date('2027-08-31') });
    expect(() => applyEvent(c, { type: 'EXPIRE' }, TODAY)).toThrow(/terme/i);
  });

  test('EC-13 — un contrat à durée indéterminée n’expire jamais', () => {
    const c = draft({ status: 'ACTIVE', endDate: null });
    expect(() => applyEvent(c, { type: 'EXPIRE' }, TODAY)).toThrow(/indéterminée/i);
  });
});

// ===========================================================================
// allowedEvents — alimente allowed_transitions de l'API (§14.3)
// ===========================================================================

describe('allowedEvents', () => {
  test('un DRAFT complet propose soumission et annulation', () => {
    expect(allowedEvents(draft()).sort()).toEqual(['CANCEL', 'EDIT_CONTENT', 'SUBMIT_FOR_REVIEW']);
  });

  test('les états terminaux ne proposent rien', () => {
    for (const status of ['CANCELLED', 'DECLINED', 'RENEWED', 'TERMINATED'] as const) {
      expect(allowedEvents(draft({ status })), status).toEqual([]);
    }
  });

  test('l’interface n’a pas à réimplémenter la machine à états', () => {
    // §14.3 : allowed_transitions permet de désactiver les bons boutons
    // sans dupliquer les règles côté client. Le domaine reste la seule
    // source de vérité.
    const c = draft({ status: 'IN_REVIEW', submittedByUserId: 'u1' });
    expect(allowedEvents(c)).toContain('APPROVE');
    expect(allowedEvents(c)).toContain('REQUEST_CHANGES');
    expect(allowedEvents(c)).not.toContain('SEND_FOR_SIGNATURE');
  });
});

// Import tardif : assertCanAmend est une garde, pas une transition.
import { assertCanAmend } from '../src/contract/state-machine.js';
