import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { bullConnection } from '../jobs/bullmq-job-queue.js';

/**
 * File des propositions (lot 9) : capture des preuves de signature puis
 * conversion en contrat, dans le `worker`. File DISTINCTE de `lsi-jobs` : le
 * module ne modifie ni le port ni le worker existants (aucune régression
 * possible sur les contrats).
 */
export const PROPOSAL_JOB_QUEUE = Symbol('PROPOSAL_JOB_QUEUE');
export const PROPOSAL_QUEUE_NAME = 'lsi-proposals';

export interface ProposalJobRef {
  readonly proposalId: string;
  readonly tenantId: string;
  readonly customerId: string;
}

export interface ProposalJobQueue {
  /** Rapatrier le PDF signé et le journal DocuSeal, puis passer SIGNÉE. */
  enqueueCapture(ref: ProposalJobRef & { signatureRequestId: string }): Promise<void>;
  /** Conversion en contrat (idempotente). */
  enqueueConvert(ref: ProposalJobRef): Promise<void>;
}

@Injectable()
export class BullMqProposalJobQueue implements ProposalJobQueue, OnModuleDestroy {
  private readonly queue = new Queue(PROPOSAL_QUEUE_NAME, { connection: bullConnection() });

  async enqueueCapture(ref: ProposalJobRef & { signatureRequestId: string }): Promise<void> {
    await this.queue.add('proposal-capture', ref, {
      attempts: 8,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 200,
      removeOnFail: 1_000,
      // Idempotence : un seul job par soumission (webhook ET réconciliation). Pas de « : » (BullMQ v5).
      jobId: `proposal-capture-${ref.signatureRequestId}`,
    });
  }

  async enqueueConvert(ref: ProposalJobRef): Promise<void> {
    await this.queue.add('proposal-convert', ref, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 1_000,
      jobId: `proposal-convert-${ref.proposalId}`,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/** Sans Redis (tests, dev) : rien n'est enfilé ; le balayage périodique rattrape. */
@Injectable()
export class NoOpProposalJobQueue implements ProposalJobQueue {
  private readonly log = new Logger(NoOpProposalJobQueue.name);
  async enqueueCapture(ref: ProposalJobRef & { signatureRequestId: string }): Promise<void> {
    this.log.debug(`capture ignorée (no-op) : ${ref.signatureRequestId}`);
  }
  async enqueueConvert(ref: ProposalJobRef): Promise<void> {
    this.log.debug(`conversion ignorée (no-op) : ${ref.proposalId}`);
  }
}
