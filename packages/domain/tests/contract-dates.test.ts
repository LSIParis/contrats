import { describe, test, expect } from 'vitest';
import {
  addMonthsClamped,
  noticeDeadline,
  computeTerminationEffectiveDate,
  nextPeriodEnd,
  chatelNoticeWindow,
  subtractNotice,
} from '../src/contract/dates.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('arithmétique calendaire', () => {
  test('ajout de mois avec rabattement en fin de mois', () => {
    expect(iso(addMonthsClamped(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(iso(addMonthsClamped(d('2028-01-31'), 1))).toBe('2028-02-29'); // bissextile
    expect(iso(addMonthsClamped(d('2026-03-31'), -1))).toBe('2026-02-28');
    expect(iso(addMonthsClamped(d('2026-12-15'), 1))).toBe('2027-01-15');
    expect(iso(addMonthsClamped(d('2026-05-31'), 12))).toBe('2027-05-31');
  });

  test('retrait d’un préavis en jours ou en mois', () => {
    expect(iso(subtractNotice(d('2026-12-31'), { days: 90 }))).toBe('2026-10-02');
    expect(iso(subtractNotice(d('2026-12-31'), { months: 3 }))).toBe('2026-09-30');
    expect(iso(subtractNotice(d('2026-12-31'), {}))).toBe('2026-12-31');
  });

  test('le préavis ne peut pas être exprimé à la fois en jours et en mois', () => {
    expect(() => subtractNotice(d('2026-12-31'), { days: 30, months: 1 })).toThrow(/jours ou en mois/);
  });
});

describe('date limite de dénonciation', () => {
  test('fin de période − préavis', () => {
    expect(iso(noticeDeadline(d('2026-12-31'), { months: 3 }))).toBe('2026-09-30');
  });
});

describe('date d’effet d’une résiliation (calcul automatique selon le préavis)', () => {
  test('durée indéterminée : aujourd’hui + préavis, ou la date demandée si plus tardive', () => {
    const r = computeTerminationEffectiveDate({
      today: d('2026-07-16'), notice: { days: 30 }, periodEnd: null, renewalPeriodMonths: null,
    });
    expect(iso(r.effectiveDate)).toBe('2026-08-15');
    const later = computeTerminationEffectiveDate({
      today: d('2026-07-16'), notice: { days: 30 }, periodEnd: null, renewalPeriodMonths: null,
      requestedDate: d('2026-10-01'),
    });
    expect(iso(later.effectiveDate)).toBe('2026-10-01');
  });

  test('période à terme dénoncée à temps : effet au terme de la période en cours', () => {
    const r = computeTerminationEffectiveDate({
      today: d('2026-07-16'), notice: { months: 3 }, periodEnd: d('2026-12-31'), renewalPeriodMonths: 12,
    });
    expect(iso(r.effectiveDate)).toBe('2026-12-31');
    expect(r.deadlineMissed).toBe(false);
  });

  test('dénonciation tardive : effet au terme de la période SUIVANTE (reconduction intervenue)', () => {
    const r = computeTerminationEffectiveDate({
      today: d('2026-10-15'), notice: { months: 3 }, periodEnd: d('2026-12-31'), renewalPeriodMonths: 12,
    });
    expect(iso(r.effectiveDate)).toBe('2027-12-31');
    expect(r.deadlineMissed).toBe(true);
  });

  test('à la date limite exacte, la dénonciation est encore à temps', () => {
    const r = computeTerminationEffectiveDate({
      today: d('2026-09-30'), notice: { months: 3 }, periodEnd: d('2026-12-31'), renewalPeriodMonths: 12,
    });
    expect(iso(r.effectiveDate)).toBe('2026-12-31');
  });

  test('sans reconduction, une dénonciation tardive prend effet au terme (pas au-delà)', () => {
    const r = computeTerminationEffectiveDate({
      today: d('2026-10-15'), notice: { months: 3 }, periodEnd: d('2026-12-31'), renewalPeriodMonths: null,
    });
    expect(iso(r.effectiveDate)).toBe('2026-12-31');
  });
});

describe('reconduction', () => {
  test('la période suivante commence le lendemain du terme', () => {
    expect(iso(nextPeriodEnd(d('2026-12-31'), 12))).toBe('2027-12-31');
    expect(iso(nextPeriodEnd(d('2026-06-30'), 6))).toBe('2026-12-31');
    expect(iso(nextPeriodEnd(d('2026-02-28'), 12))).toBe('2027-02-28');
  });
});

describe('loi Chatel (L215-1 C. conso.)', () => {
  test('information au plus tôt 3 mois, au plus tard 1 mois avant la date limite de dénonciation', () => {
    const w = chatelNoticeWindow(d('2026-12-31'), { months: 1 });
    // date limite = 30/11 ; fenêtre = [30/08 ; 30/10] (même quantième, 3 et 1 mois avant)
    expect(iso(w.deadline)).toBe('2026-11-30');
    expect(iso(w.earliest)).toBe('2026-08-30');
    expect(iso(w.latest)).toBe('2026-10-30');
  });
});
