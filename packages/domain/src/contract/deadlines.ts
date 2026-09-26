import type { ContractStatus } from './contract.types.js';
import { chatelNoticeWindow, noticeDeadline, type Notice } from './dates.js';

/**
 * Échéancier d'un contrat (02-cycle-de-vie.md §6). Fonction PURE : à partir
 * des faits contractuels, la liste des échéances à matérialiser. Le job
 * quotidien compare cette liste à la table `deadlines` et en déduit les
 * créations, les obsolescences et les alertes.
 */
export type DeadlineKind =
  | 'PERIOD_END'
  | 'NOTICE_DEADLINE'
  | 'PRICE_REVISION'
  | 'RENEWAL_DECISION'
  | 'CHATEL_NOTICE'
  | 'TERMINATION_EFFECTIVE';

export interface DeadlineFacts {
  readonly status: ContractStatus;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly notice: Notice;
  readonly renewalMode: 'NONE' | 'TACIT' | 'EXPRESS';
  readonly renewalPeriodMonths: number | null;
  /** Client consommateur/non-professionnel, ou option forcée sur le contrat. */
  readonly chatelApplies: boolean;
  readonly terminationEffectiveDate: Date | null;
  /** Prochaine révision prévue par le barème (lot 3), s'il y en a une. */
  readonly nextPriceRevisionDate: Date | null;
}

export interface ComputedDeadline {
  readonly kind: DeadlineKind;
  readonly dueDate: Date;
  /** Informations d'affichage (dates ISO), jamais utilisées pour décider. */
  readonly details: Record<string, string>;
}

/** États dans lesquels le contrat engage les parties et a donc un échéancier. */
const ENGAGED: readonly ContractStatus[] = ['SIGNED', 'ACTIVE', 'RENEWAL_DUE', 'TERMINATION_PENDING'];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function computeDeadlines(f: DeadlineFacts, _now: Date): ComputedDeadline[] {
  if (!ENGAGED.includes(f.status)) return [];
  const out: ComputedDeadline[] = [];

  if (f.status === 'TERMINATION_PENDING' && f.terminationEffectiveDate) {
    out.push({ kind: 'TERMINATION_EFFECTIVE', dueDate: f.terminationEffectiveDate, details: {} });
  }

  if (f.endDate) {
    const deadline = noticeDeadline(f.endDate, f.notice);
    out.push({ kind: 'PERIOD_END', dueDate: f.endDate, details: {} });
    // Une résiliation déjà programmée rend la dénonciation sans objet.
    if (f.status !== 'TERMINATION_PENDING') {
      out.push({ kind: 'NOTICE_DEADLINE', dueDate: deadline, details: { periodEnd: iso(f.endDate) } });
      if (f.renewalMode === 'EXPRESS') {
        out.push({ kind: 'RENEWAL_DECISION', dueDate: deadline, details: { periodEnd: iso(f.endDate) } });
      }
      if (f.renewalMode === 'TACIT' && f.chatelApplies) {
        const w = chatelNoticeWindow(f.endDate, f.notice);
        out.push({
          kind: 'CHATEL_NOTICE',
          dueDate: w.earliest,
          details: { latest: iso(w.latest), noticeDeadline: iso(w.deadline), periodEnd: iso(f.endDate) },
        });
      }
    }
  }

  if (f.nextPriceRevisionDate) {
    out.push({ kind: 'PRICE_REVISION', dueDate: f.nextPriceRevisionDate, details: {} });
  }
  return out;
}
