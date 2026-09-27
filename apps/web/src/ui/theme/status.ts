/**
 * Palette des badges de statut du cycle de vie.
 *
 * Les TONS sont exactement ceux des pastilles de lticket (apps/console/src/styles.css
 * l. 287-307, `.badge`, `.badge-ok|warn|danger|info`, `.badge-p4`) : un texte coloré sur son
 * propre fond clair, chacun à ≥ 4,5:1. lticket n'a que ces tons ; pour distinguer vingt statuts
 * on garde la même règle que lui — LA COULEUR NE PORTE JAMAIS SEULE LE SENS (ui.tsx : « le code
 * seul ne dit rien… toujours accompagné du mot ») — et chaque statut reçoit en plus une icône
 * propre et son libellé français.
 *
 * Les classes Tailwind sont écrites en toutes lettres (pas de concaténation) pour que le
 * compilateur JIT les retrouve.
 */
import type { ContractStatusCode } from '../../lib/labels.js';
import type { IconName } from '../icons.js';
import { mint, slate, semantic } from './tokens.js';

export type StatusTone = 'neutral' | 'muted' | 'info' | 'success' | 'warn' | 'danger';

export const STATUS_TONES: Record<StatusTone, { fg: string; bg: string; className: string; lticket: string }> = {
  neutral: { fg: slate[700], bg: slate[100], className: 'bg-slate-100 text-slate-700', lticket: '.badge (l. 287-292)' },
  muted: { fg: slate[600], bg: slate[100], className: 'bg-slate-100 text-slate-600', lticket: '.badge-p4 / .badge-count (l. 307, 576)' },
  info: { fg: mint[800], bg: mint[50], className: 'bg-info-bg text-info', lticket: '.badge-info (l. 296)' },
  success: { fg: semantic.success, bg: semantic.successBg, className: 'bg-success-bg text-success', lticket: '.badge-ok (l. 293)' },
  warn: { fg: semantic.warn, bg: semantic.warnBg, className: 'bg-warn-bg text-warn', lticket: '.badge-warn (l. 294)' },
  danger: { fg: semantic.danger, bg: semantic.dangerBg, className: 'bg-danger-bg text-danger', lticket: '.badge-danger (l. 295)' },
};

/** Un ton + une icône par statut. Le libellé vient de `lib/labels.ts`. */
export const STATUS_STYLES: Record<ContractStatusCode, { tone: StatusTone; icon: IconName }> = {
  DRAFT: { tone: 'neutral', icon: 'pencil' },
  IN_REVIEW: { tone: 'info', icon: 'eye' },
  CHANGES_REQUESTED: { tone: 'warn', icon: 'undo' },
  APPROVED: { tone: 'success', icon: 'check' },
  SENT_TO_CLIENT: { tone: 'info', icon: 'send' },
  IN_NEGOTIATION: { tone: 'warn', icon: 'message' },
  ACCEPTED: { tone: 'success', icon: 'checkCircle' },
  PENDING_SIGNATURE: { tone: 'warn', icon: 'pen' },
  PARTIALLY_SIGNED: { tone: 'info', icon: 'penHalf' },
  SIGNED: { tone: 'success', icon: 'fileCheck' },
  ACTIVE: { tone: 'success', icon: 'shield' },
  RENEWAL_DUE: { tone: 'warn', icon: 'clock' },
  RENEWED: { tone: 'info', icon: 'refresh' },
  TERMINATION_PENDING: { tone: 'danger', icon: 'hourglass' },
  TERMINATED: { tone: 'neutral', icon: 'octagonX' },
  EXPIRED: { tone: 'danger', icon: 'calendarX' },
  CANCELLED: { tone: 'muted', icon: 'ban' },
  DECLINED: { tone: 'danger', icon: 'xCircle' },
  SIGNATURE_EXPIRED: { tone: 'danger', icon: 'alertCircle' },
  IMPORTED_PENDING_VALIDATION: { tone: 'warn', icon: 'download' },
};
