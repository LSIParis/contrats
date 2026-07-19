import { describe, test, expect } from 'vitest';
import { applyEvent, allowedEvents, BusinessRuleError, type ContractSnapshot } from '../src/index.js';

function draft(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    id: 'c1', type: 'MAIN', status: 'DRAFT',
    startDate: new Date('2026-07-01'), endDate: null, noticePeriodDays: null,
    currentVersionId: 'v1', approvedVersionId: null, submittedByUserId: null,
    hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
    openAmendmentExists: false, hasSignedSuccessor: false,
    signedAt: null, activatedAt: null, terminatedAt: null,
    ...over,
  };
}

describe('RM-11 — contenu requis pour soumettre', () => {
  test('sans currentVersionId, SUBMIT lève une BusinessRuleError', () => {
    expect(() => applyEvent(draft({ currentVersionId: null }), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, new Date()))
      .toThrow(BusinessRuleError);
  });

  test('sans currentVersionId, allowedEvents ne liste pas SUBMIT_FOR_REVIEW', () => {
    expect(allowedEvents(draft({ currentVersionId: null }))).not.toContain('SUBMIT_FOR_REVIEW');
  });

  test('avec currentVersionId + signataires + date, SUBMIT est autorisé et passe à IN_REVIEW', () => {
    expect(allowedEvents(draft())).toContain('SUBMIT_FOR_REVIEW');
    const next = applyEvent(draft(), { type: 'SUBMIT_FOR_REVIEW', actorUserId: 'u1' }, new Date());
    expect(next.status).toBe('IN_REVIEW');
  });
});
