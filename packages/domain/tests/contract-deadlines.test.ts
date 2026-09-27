import { describe, test, expect } from 'vitest';
import { computeDeadlines, type DeadlineFacts } from '../src/contract/deadlines.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const NOW = d('2026-07-16');

function facts(over: Partial<DeadlineFacts> = {}): DeadlineFacts {
  return {
    status: 'ACTIVE',
    startDate: d('2026-01-01'),
    endDate: d('2026-12-31'),
    notice: { months: 3 },
    renewalMode: 'NONE',
    renewalPeriodMonths: null,
    chatelApplies: false,
    terminationEffectiveDate: null,
    nextPriceRevisionDate: null,
    ...over,
  };
}

const summary = (f: DeadlineFacts) =>
  computeDeadlines(f, NOW).map((x) => `${x.kind}@${iso(x.dueDate)}`).sort();

describe('échéancier (02-cycle-de-vie §6)', () => {
  test('contrat à terme sans reconduction : fin de période et date limite de préavis', () => {
    expect(summary(facts())).toEqual(['NOTICE_DEADLINE@2026-09-30', 'PERIOD_END@2026-12-31']);
  });

  test('reconduction expresse : décision de renouvellement à la date limite', () => {
    expect(summary(facts({ renewalMode: 'EXPRESS', renewalPeriodMonths: 12 }))).toEqual([
      'NOTICE_DEADLINE@2026-09-30', 'PERIOD_END@2026-12-31', 'RENEWAL_DECISION@2026-09-30',
    ]);
  });

  test('tacite reconduction + consommateur : information Chatel au plus tôt 3 mois avant la date limite', () => {
    const r = computeDeadlines(facts({ renewalMode: 'TACIT', renewalPeriodMonths: 12, chatelApplies: true }), NOW);
    const chatel = r.find((x) => x.kind === 'CHATEL_NOTICE')!;
    expect(iso(chatel.dueDate)).toBe('2026-06-30');
    expect(chatel.details).toMatchObject({ latest: '2026-08-30', noticeDeadline: '2026-09-30' });
  });

  test('pas d’information Chatel sans reconduction tacite', () => {
    expect(summary(facts({ chatelApplies: true }))).not.toContain('CHATEL_NOTICE@2026-06-30');
  });

  test('durée indéterminée : aucune échéance de terme ni de préavis', () => {
    expect(summary(facts({ endDate: null }))).toEqual([]);
  });

  test('résiliation programmée : date d’effet', () => {
    expect(summary(facts({ status: 'TERMINATION_PENDING', terminationEffectiveDate: d('2026-10-31') }))).toContain(
      'TERMINATION_EFFECTIVE@2026-10-31',
    );
  });

  test('révision tarifaire fournie par le barème', () => {
    expect(summary(facts({ nextPriceRevisionDate: d('2027-01-01') }))).toContain('PRICE_REVISION@2027-01-01');
  });

  test('un contrat non engagé (brouillon, annulé, résilié, expiré) n’a pas d’échéance', () => {
    for (const status of ['DRAFT', 'CANCELLED', 'TERMINATED', 'EXPIRED', 'RENEWED', 'IMPORTED_PENDING_VALIDATION'] as const) {
      expect(computeDeadlines(facts({ status }), NOW), status).toEqual([]);
    }
  });

  test('un contrat SIGNÉ à effet futur a déjà ses échéances', () => {
    expect(summary(facts({ status: 'SIGNED', startDate: d('2026-09-01') }))).toContain('PERIOD_END@2026-12-31');
  });

  test('préavis nul : la date limite est le terme lui-même', () => {
    expect(summary(facts({ notice: {} }))).toEqual(['NOTICE_DEADLINE@2026-12-31', 'PERIOD_END@2026-12-31']);
  });

  test('déterministe et pur', () => {
    const f = facts({ renewalMode: 'TACIT', renewalPeriodMonths: 12, chatelApplies: true });
    const snapshot = JSON.stringify(f);
    expect(computeDeadlines(f, NOW)).toEqual(computeDeadlines(f, NOW));
    expect(JSON.stringify(f)).toBe(snapshot);
  });
});
