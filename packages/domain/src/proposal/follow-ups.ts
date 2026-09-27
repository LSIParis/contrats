/**
 * Relances automatiques (brief §12.5) : J+3 sans ouverture, J+7 sans
 * décision, J-2 avant expiration par défaut ; suspendues dès qu'une réponse
 * arrive, désactivables, JAMAIS plus d'une relance par 48 h.
 *
 * Deux fonctions pures : `planFollowUps` (à l'envoi, lignes PLANNED) et
 * `decideFollowUp` (quand une relance planifiée arrive à échéance, par le job).
 */
import type { ProposalStatus } from './proposal.types.js';

export type FollowUpKind = 'NO_OPEN' | 'NO_DECISION' | 'BEFORE_EXPIRY';

export interface FollowUpConfig {
  readonly noOpenAfterDays: number;
  readonly noDecisionAfterDays: number;
  readonly beforeExpiryDays: number;
}

export const DEFAULT_FOLLOW_UPS: FollowUpConfig = { noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 };

/** Espacement minimal entre deux relances d'une même proposition. */
export const FOLLOW_UP_MIN_SPACING_MS = 48 * 3600 * 1000;

const DAY = 24 * 3600 * 1000;

export function planFollowUps(
  sentAt: Date,
  expiresAt: Date,
  cfg: FollowUpConfig,
): { kind: FollowUpKind; dueAt: Date }[] {
  const plan = [
    { kind: 'NO_OPEN' as const, dueAt: new Date(sentAt.getTime() + cfg.noOpenAfterDays * DAY) },
    { kind: 'NO_DECISION' as const, dueAt: new Date(sentAt.getTime() + cfg.noDecisionAfterDays * DAY) },
    { kind: 'BEFORE_EXPIRY' as const, dueAt: new Date(expiresAt.getTime() - cfg.beforeExpiryDays * DAY) },
  ];
  // Une relance qui tomberait après l'échéance (ou avant l'envoi) n'a pas de sens.
  return plan.filter((p) => p.dueAt > sentAt && p.dueAt < expiresAt);
}

export interface FollowUpContext {
  readonly status: ProposalStatus;
  readonly enabled: boolean;
  readonly firstViewedAt: Date | null;
  /** Dernière réponse du client (question, commentaire, acceptation, refus). */
  readonly clientRespondedAt: Date | null;
  readonly lastFollowUpSentAt: Date | null;
  readonly expiresAt: Date | null;
}

export type FollowUpDecision =
  | { readonly action: 'SEND' }
  | { readonly action: 'SKIP'; readonly reason: string }
  | { readonly action: 'POSTPONE'; readonly until: Date };

export function decideFollowUp(kind: FollowUpKind, ctx: FollowUpContext, now: Date): FollowUpDecision {
  if (!ctx.enabled) return { action: 'SKIP', reason: 'relances désactivées' };
  // Une discussion ouverte EST une réponse : on ne relance pas quelqu'un qui parle.
  if (ctx.status !== 'SENT' && ctx.status !== 'VIEWED') return { action: 'SKIP', reason: `statut ${ctx.status}` };
  if (ctx.clientRespondedAt) return { action: 'SKIP', reason: 'réponse du client reçue' };
  if (ctx.expiresAt && ctx.expiresAt <= now) return { action: 'SKIP', reason: 'proposition échue' };
  if (kind === 'NO_OPEN' && (ctx.firstViewedAt || ctx.status !== 'SENT')) {
    return { action: 'SKIP', reason: 'proposition déjà ouverte' };
  }
  if (ctx.lastFollowUpSentAt && now.getTime() - ctx.lastFollowUpSentAt.getTime() < FOLLOW_UP_MIN_SPACING_MS) {
    return { action: 'POSTPONE', until: new Date(ctx.lastFollowUpSentAt.getTime() + FOLLOW_UP_MIN_SPACING_MS) };
  }
  return { action: 'SEND' };
}
