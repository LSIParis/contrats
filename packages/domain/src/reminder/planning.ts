/**
 * Planification des rappels d'échéance. (§12.2)
 *
 * Fonction PURE. Les rappels sont MATÉRIALISÉS (§12.1) : cette fonction
 * produit des lignes à insérer, elle ne décide pas d'envoyer.
 *
 * La différence n'est pas cosmétique. Si les rappels étaient calculés à la
 * volée par le job nocturne, un scheduler en panne 3 jours signifierait que
 * les rappels de ces 3 jours N'EXISTENT JAMAIS. Un contrat perdu parce qu'un
 * cron a échoué pendant un week-end, c'est le problème n°1 que cette
 * application existe pour résoudre.
 */

export type ReminderKind = 'EXPIRY' | 'NOTICE_DEADLINE';
export type ReminderStatus = 'PENDING' | 'SKIPPED_OBSOLETE';

/** Les offsets du dossier. J-90 interne, J-60 +client, J-30 +escalade (RM-27). */
export const EXPIRY_OFFSETS = [90, 60, 30] as const;

export interface ReminderPlanInput {
  /** null = durée indéterminée (EC-13). */
  readonly endDate: Date | null;
  readonly noticePeriodDays: number | null;
  readonly reminderCycle: number;
}

export interface ReminderDraft {
  readonly kind: ReminderKind;
  readonly offsetDays: number;
  readonly cycle: number;
  readonly dueAt: Date;
  readonly status: ReminderStatus;
}

function subDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() - n);
  return r;
}

export function planReminders(c: ReminderPlanInput, now: Date): ReminderDraft[] {
  // EC-13 : un contrat sans terme n'expire pas. À la place, on rappelle
  // l'échéance du préavis de résiliation — la seule date qui compte alors.
  if (!c.endDate) {
    if (!c.noticePeriodDays) return [];
    return [
      {
        kind: 'NOTICE_DEADLINE',
        offsetDays: c.noticePeriodDays,
        cycle: c.reminderCycle,
        dueAt: subDays(now, -c.noticePeriodDays),
        status: 'PENDING',
      },
    ];
  }

  const endDate = c.endDate;
  return EXPIRY_OFFSETS.map((offsetDays) => {
    const dueAt = subDays(endDate, offsetDays);
    return {
      kind: 'EXPIRY' as const,
      offsetDays,
      cycle: c.reminderCycle,
      dueAt,
      // RM-25 / EC-02 : on crée la ligne MÊME si l'échéance est déjà passée.
      // Le silence n'est jamais une donnée : on veut pouvoir prouver qu'un
      // rappel n'est pas parti, et pourquoi.
      status: dueAt <= now ? ('SKIPPED_OBSOLETE' as const) : ('PENDING' as const),
    };
  });
}

export interface ReplanResult {
  readonly newCycle: number;
  /** Le cycle dont les rappels PENDING doivent passer CANCELLED. */
  readonly cancelPreviousCycle: number;
  readonly reminders: ReminderDraft[];
}

/**
 * EC-12 : la date de fin a changé (avenant signé).
 *
 * On incrémente le cycle plutôt que de supprimer : la contrainte
 * UNIQUE (contract_id, kind, offset_days, cycle) autorise ainsi la
 * coexistence des cycles, tout en interdisant le doublon dans un cycle donné.
 * L'historique des rappels est lui aussi une preuve.
 *
 * Un rappel obsolète est pire qu'aucun rappel : l'ancien cycle doit être
 * annulé, pas laissé en attente.
 */
export function replanAfterEndDateChange(c: ReminderPlanInput, now: Date): ReplanResult {
  const newCycle = c.reminderCycle + 1;
  return {
    newCycle,
    cancelPreviousCycle: c.reminderCycle,
    reminders: planReminders({ ...c, reminderCycle: newCycle }, now),
  };
}
