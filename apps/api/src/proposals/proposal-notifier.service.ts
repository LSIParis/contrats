import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { uuidv7 } from '@lsi/persistence';
import type { EmailSender } from '@lsi/domain';
import { EMAIL_SENDER } from '../notifications/email.token.js';
import { REDIS } from '../auth/redis.provider.js';

/**
 * Notifications au commercial (brief §12.5) : dans l'application (ligne
 * `notifications` + flux SSE temps réel) et par e-mail, pour la première
 * ouverture, le retour après plusieurs jours, une question, une option
 * modifiée, l'acceptation, la signature et le refus.
 *
 * DEUX temps, comme la capture de preuve :
 *   - `record(tx, …)` DANS la transaction métier : la notification in-app
 *     existe si et seulement si le fait est commité ; `dedupKey` (UNIQUE)
 *     évite les doublons (webhook rejoué, options modifiées en rafale) ;
 *   - `flush(…)` APRÈS commit : diffusion SSE (Redis pub/sub, tous les
 *     conteneurs `app`) et e-mail — best-effort, jamais bloquant.
 */
export type ProposalNoticeType =
  | 'proposal.first_open'
  | 'proposal.returned'
  | 'proposal.new_viewer'
  | 'proposal.question'
  | 'proposal.option_changed'
  | 'proposal.accepted'
  | 'proposal.signed'
  | 'proposal.declined'
  | 'proposal.expired'
  | 'proposal.signature_declined'
  | 'proposal.converted'
  | 'proposal.conversion_failed';

/** Notifications doublées d'un e-mail (brief §12.5). */
const EMAILED: ReadonlySet<ProposalNoticeType> = new Set([
  'proposal.first_open',
  'proposal.returned',
  'proposal.question',
  'proposal.option_changed',
  'proposal.accepted',
  'proposal.signed',
  'proposal.declined',
  'proposal.signature_declined',
  'proposal.conversion_failed',
]);

export interface ProposalNotice {
  readonly tenantId: string;
  readonly customerId: string;
  readonly proposalId: string;
  readonly recipientUserId: string;
  readonly recipientEmail: string | null;
  readonly type: ProposalNoticeType;
  readonly subject: string;
  readonly body: string;
  readonly dedupKey?: string;
}

export const proposalChannel = (tenantId: string) => `lsi:proposals:${tenantId}`;

export interface StreamMessage {
  readonly userId: string;
  readonly proposalId: string;
  readonly type: ProposalNoticeType;
  readonly subject: string;
  readonly at: string;
}

@Injectable()
export class ProposalNotifier implements OnModuleDestroy {
  private readonly log = new Logger(ProposalNotifier.name);
  private subscriber?: Redis;

  constructor(
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Écrit la notification in-app ; renvoie null si elle existait déjà (dédoublonnage). */
  async record(tx: any, n: ProposalNotice, now: Date): Promise<ProposalNotice | null> {
    const r = await tx.notification.createMany({
      data: [
        {
          id: uuidv7(),
          tenantId: n.tenantId,
          customerId: n.customerId,
          recipientUserId: n.recipientUserId,
          channel: 'IN_APP',
          type: n.type,
          subject: n.subject,
          body: n.body,
          relatedProposalId: n.proposalId,
          status: 'SENT',
          sentAt: now,
          dedupKey: n.dedupKey ?? `${n.type}:${n.proposalId}:${uuidv7()}`,
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
    return r.count > 0 ? n : null;
  }

  /** Diffusion temps réel + e-mail, après commit. N'échoue jamais. */
  async flush(notices: readonly (ProposalNotice | null)[]): Promise<void> {
    for (const n of notices) {
      if (!n) continue;
      const msg: StreamMessage = { userId: n.recipientUserId, proposalId: n.proposalId, type: n.type, subject: n.subject, at: new Date().toISOString() };
      try {
        await this.redis.publish(proposalChannel(n.tenantId), JSON.stringify(msg));
      } catch (e) {
        this.log.warn(`diffusion SSE impossible : ${(e as Error).message}`);
      }
      if (EMAILED.has(n.type) && n.recipientEmail) {
        try {
          await this.email.send({ to: n.recipientEmail, subject: n.subject, text: n.body });
        } catch (e) {
          this.log.warn(`e-mail de notification non envoyé (${n.type}) : ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Abonnement au flux d'un tenant (SSE). Une connexion Redis d'abonnement
   * partagée par processus ; chaque flux filtre ses propres messages.
   */
  subscribe(tenantId: string, onMessage: (m: StreamMessage) => void): () => void {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.setMaxListeners(1000);
    }
    const sub = this.subscriber;
    const channel = proposalChannel(tenantId);
    const handler = (ch: string, raw: string) => {
      if (ch !== channel) return;
      try {
        onMessage(JSON.parse(raw) as StreamMessage);
      } catch {
        /* message illisible : ignoré */
      }
    };
    sub.on('message', handler);
    void sub.subscribe(channel).catch((e: Error) => this.log.warn(`abonnement SSE impossible : ${e.message}`));
    return () => {
      sub.off('message', handler);
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }
}
