import { describe, test, expect } from 'vitest';
import { applyEvent, allowedEvents, type ContractSnapshot } from '../src/index.js';

function pending(status: 'PENDING_SIGNATURE' | 'PARTIALLY_SIGNED'): ContractSnapshot {
  return {
    id: 'c1', type: 'MAIN', status,
    startDate: new Date('2026-07-01'), endDate: null, noticePeriodDays: null,
    currentVersionId: 'v1', approvedVersionId: 'v1', submittedByUserId: null,
    hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
    openAmendmentExists: false, hasSignedSuccessor: false,
    signedAt: null, activatedAt: null, terminatedAt: null,
  };
}

describe('REVOKE_SIGNATURE', () => {
  test('depuis PENDING_SIGNATURE → APPROVED (approvedVersionId conservé)', () => {
    const next = applyEvent(pending('PENDING_SIGNATURE'), { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date());
    expect(next.status).toBe('APPROVED');
    expect(next.approvedVersionId).toBe('v1');
  });

  test('depuis PARTIALLY_SIGNED → APPROVED', () => {
    expect(applyEvent(pending('PARTIALLY_SIGNED'), { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date()).status).toBe('APPROVED');
  });

  test('allowedEvents inclut REVOKE_SIGNATURE en PENDING_SIGNATURE', () => {
    expect(allowedEvents(pending('PENDING_SIGNATURE'))).toContain('REVOKE_SIGNATURE');
  });

  test('depuis APPROVED, REVOKE_SIGNATURE est une transition invalide', () => {
    const approved = { ...pending('PENDING_SIGNATURE'), status: 'APPROVED' as const };
    expect(() => applyEvent(approved, { type: 'REVOKE_SIGNATURE', actorUserId: 'u1' }, new Date())).toThrow();
  });
});
