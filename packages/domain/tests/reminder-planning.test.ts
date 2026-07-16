import { describe, test, expect } from 'vitest';
import { planReminders, replanAfterEndDateChange } from '../src/reminder/planning.js';

const NOW = new Date('2026-07-16T06:00:00Z');

function contract(over: Partial<Parameters<typeof planReminders>[0]> = {}) {
  return {
    endDate: new Date('2027-08-31'),
    noticePeriodDays: 90,
    reminderCycle: 0,
    ...over,
  };
}

describe('planification nominale', () => {
  test('un contrat à échéance lointaine reçoit 3 rappels PENDING', () => {
    const r = planReminders(contract(), NOW);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.offsetDays)).toEqual([90, 60, 30]);
    expect(r.every((x) => x.status === 'PENDING')).toBe(true);
    expect(r.every((x) => x.kind === 'EXPIRY')).toBe(true);
  });

  test('les dates d’échéance sont end_date moins l’offset', () => {
    const r = planReminders(contract({ endDate: new Date('2027-08-31') }), NOW);
    expect(r[0]!.dueAt.toISOString().slice(0, 10)).toBe('2027-06-02'); // -90
    expect(r[1]!.dueAt.toISOString().slice(0, 10)).toBe('2027-07-02'); // -60
    expect(r[2]!.dueAt.toISOString().slice(0, 10)).toBe('2027-08-01'); // -30
  });
});

describe('EC-02 / RM-25 — échéance déjà proche à l’activation', () => {
  test('un contrat expirant dans 45 j : 90 et 60 naissent SKIPPED_OBSOLETE, 30 reste PENDING', () => {
    // Le silence n'est jamais une donnée : on CRÉE quand même les lignes,
    // pour pouvoir prouver qu'un rappel n'est pas parti, et pourquoi.
    const r = planReminders(contract({ endDate: new Date('2026-08-30') }), NOW);
    expect(r).toHaveLength(3);
    expect(r.find((x) => x.offsetDays === 90)!.status).toBe('SKIPPED_OBSOLETE');
    expect(r.find((x) => x.offsetDays === 60)!.status).toBe('SKIPPED_OBSOLETE');
    expect(r.find((x) => x.offsetDays === 30)!.status).toBe('PENDING');
  });

  test('EC-01 — un contrat déjà expiré ne génère aucun rappel PENDING', () => {
    const r = planReminders(contract({ endDate: new Date('2026-01-01') }), NOW);
    expect(r.every((x) => x.status === 'SKIPPED_OBSOLETE')).toBe(true);
  });
});

describe('EC-13 — durée indéterminée', () => {
  test('sans end_date mais avec préavis : un rappel NOTICE_DEADLINE', () => {
    const r = planReminders(contract({ endDate: null, noticePeriodDays: 90 }), NOW);
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('NOTICE_DEADLINE');
  });

  test('sans end_date ni préavis : aucun rappel', () => {
    const r = planReminders(contract({ endDate: null, noticePeriodDays: null }), NOW);
    expect(r).toEqual([]);
  });
});

describe('RM-24 — anti-doublon par cycle', () => {
  test('la clé (offset, cycle) est unique dans une planification', () => {
    const r = planReminders(contract(), NOW);
    const keys = r.map((x) => `${x.kind}:${x.offsetDays}:${x.cycle}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('le cycle du contrat est reporté sur chaque rappel', () => {
    const r = planReminders(contract({ reminderCycle: 3 }), NOW);
    expect(r.every((x) => x.cycle === 3)).toBe(true);
  });
});

describe('EC-12 — régénération après avenant', () => {
  test('changer end_date incrémente le cycle et replanifie', () => {
    const c = contract({ endDate: new Date('2027-08-31'), reminderCycle: 0 });
    const { newCycle, reminders } = replanAfterEndDateChange(
      { ...c, endDate: new Date('2028-08-31') },
      NOW,
    );
    expect(newCycle).toBe(1);
    expect(reminders.every((x) => x.cycle === 1)).toBe(true);
    expect(reminders[0]!.dueAt.toISOString().slice(0, 10)).toBe('2028-06-02');
  });

  test('un rappel obsolète est pire qu’aucun rappel : l’ancien cycle doit être annulé', () => {
    const { cancelPreviousCycle } = replanAfterEndDateChange(
      { ...contract(), endDate: new Date('2028-08-31') },
      NOW,
    );
    expect(cancelPreviousCycle).toBe(0);
  });
});
