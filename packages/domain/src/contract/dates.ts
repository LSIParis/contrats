/**
 * Dates contractuelles : préavis, dénonciation, reconduction, loi Chatel.
 * Spécification : docs/contrats/02-cycle-de-vie.md §5.
 *
 * Toutes les fonctions sont PURES et travaillent sur des DATES CALENDAIRES
 * (minuit UTC). « Aujourd'hui » est un paramètre, jamais `new Date()` : une
 * règle métier qui lit l'horloge n'est testable qu'en trichant sur le temps.
 * La conversion vers Europe/Paris est l'affaire de l'affichage, pas du calcul.
 */

/** Préavis exprimé en jours OU en mois (jamais les deux). Vide = pas de préavis. */
export interface Notice {
  readonly days?: number | null;
  readonly months?: number | null;
}

const DAY_MS = 86_400_000;

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(utcDay(d).getTime() + n * DAY_MS);
}

/**
 * Ajout de mois calendaires avec RABATTEMENT en fin de mois : 31 janvier + 1
 * mois = 28 (ou 29) février, pas 3 mars. C'est la lecture usuelle d'un préavis
 * « d'un mois » et celle des tribunaux ; le débordement de Date.setMonth est
 * un piège classique qui décale une échéance de plusieurs jours.
 */
export function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
}

export function subtractNotice(date: Date, notice: Notice): Date {
  const { days, months } = notice;
  if (days != null && months != null) {
    throw new Error('Le préavis s’exprime en jours ou en mois, pas les deux.');
  }
  if (months != null) return addMonthsClamped(utcDay(date), -months);
  if (days != null) return addDays(date, -days);
  return utcDay(date);
}

export function addNotice(date: Date, notice: Notice): Date {
  const { days, months } = notice;
  if (days != null && months != null) {
    throw new Error('Le préavis s’exprime en jours ou en mois, pas les deux.');
  }
  if (months != null) return addMonthsClamped(utcDay(date), months);
  if (days != null) return addDays(date, days);
  return utcDay(date);
}

/** Date limite de dénonciation : dernier jour pour empêcher la reconduction. */
export function noticeDeadline(periodEnd: Date, notice: Notice): Date {
  return subtractNotice(periodEnd, notice);
}

/**
 * Terme de la période suivante : la période commence le lendemain du terme
 * actuel et dure `months` mois ; son terme est la veille de l'anniversaire.
 * (31/12/2026 + 12 mois → 31/12/2027 ; 30/06 + 6 mois → 31/12.)
 */
export function nextPeriodEnd(currentEnd: Date, months: number): Date {
  const start = addDays(currentEnd, 1);
  return addDays(addMonthsClamped(start, months), -1);
}

export interface TerminationInput {
  readonly today: Date;
  readonly notice: Notice;
  /** Terme de la période en cours ; null = durée indéterminée. */
  readonly periodEnd: Date | null;
  /** Durée de reconduction en mois ; null = pas de reconduction. */
  readonly renewalPeriodMonths: number | null;
  /** Date souhaitée par la partie qui résilie (jamais antérieure au calcul). */
  readonly requestedDate?: Date | null;
}

export interface TerminationDates {
  readonly effectiveDate: Date;
  /** Vrai si la date limite de dénonciation de la période en cours est passée. */
  readonly deadlineMissed: boolean;
}

/**
 * Date d'effet d'une résiliation, calculée selon le préavis (brief §2).
 *
 * - Durée indéterminée : aujourd'hui + préavis (ou la date demandée si plus tardive).
 * - Période à terme : le terme en cours si la dénonciation intervient au plus
 *   tard à la date limite ; sinon, s'il y a reconduction, le terme de la
 *   période SUIVANTE — le contrat aura été reconduit entre-temps et le reste
 *   jusqu'à ce terme. Sans reconduction, le contrat s'éteint de toute façon à
 *   son terme.
 */
export function computeTerminationEffectiveDate(i: TerminationInput): TerminationDates {
  const today = utcDay(i.today);
  const requested = i.requestedDate ? utcDay(i.requestedDate) : null;
  if (!i.periodEnd) {
    const min = addNotice(today, i.notice);
    return { effectiveDate: requested && requested > min ? requested : min, deadlineMissed: false };
  }
  const end = utcDay(i.periodEnd);
  const deadline = noticeDeadline(end, i.notice);
  const missed = today > deadline;
  if (!missed || !i.renewalPeriodMonths) return { effectiveDate: end, deadlineMissed: missed };
  return { effectiveDate: nextPeriodEnd(end, i.renewalPeriodMonths), deadlineMissed: true };
}

/**
 * Loi Chatel (art. L215-1 C. conso.) : le professionnel informe le
 * consommateur de sa faculté de ne pas reconduire « au plus tôt trois mois et
 * au plus tard un mois avant le terme de la période autorisant le rejet de la
 * reconduction », c'est-à-dire avant la DATE LIMITE DE DÉNONCIATION.
 * À faire valider par un juriste (V2-H11).
 */
export function chatelNoticeWindow(periodEnd: Date, notice: Notice): { deadline: Date; earliest: Date; latest: Date } {
  const deadline = noticeDeadline(periodEnd, notice);
  return {
    deadline,
    earliest: addMonthsClamped(deadline, -3),
    latest: addMonthsClamped(deadline, -1),
  };
}
