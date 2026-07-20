import { describe, test, expect } from 'vitest';
import { assertCanRenew, BusinessRuleError, type ContractSnapshot } from '../src/index.js';

const snap = (status: string): ContractSnapshot => ({
  id: 'c', type: 'MAIN', status: status as any, startDate: null, endDate: null, noticePeriodDays: null,
  currentVersionId: 'v', approvedVersionId: 'v', submittedByUserId: null,
  hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
  openAmendmentExists: false, hasSignedSuccessor: false, signedAt: null, activatedAt: null, terminatedAt: null,
});

describe('assertCanRenew', () => {
  test('ACTIVE et EXPIRED sont renouvelables', () => {
    expect(() => assertCanRenew(snap('ACTIVE'))).not.toThrow();
    expect(() => assertCanRenew(snap('EXPIRED'))).not.toThrow();
  });
  test('DRAFT/SIGNED → BusinessRuleError RM-16', () => {
    expect(() => assertCanRenew(snap('DRAFT'))).toThrow(BusinessRuleError);
    expect(() => assertCanRenew(snap('SIGNED'))).toThrow(BusinessRuleError);
  });
});
