import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_NAME,
  type CaptureProofJob,
  type JobQueue,
  type SendReminderJob,
} from './job-queue.port.js';

/**
 * Connexion Redis dédiée à BullMQ.
 *
 * `maxRetriesPerRequest: null` est EXIGÉ par BullMQ (sinon il refuse la
 * connexion). Producteur et worker ont chacun la leur.
 */
export function bullConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL absent — requis pour BullMQ');
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * Producteur BullMQ. (§11.6)
 *
 * Actif quand REDIS_URL est présent (donc en prod, et en tests d'intégration
 * qui le veulent). Le module choisit cette impl ou un no-op selon l'env.
 */
@Injectable()
export class BullMqJobQueue implements JobQueue, OnModuleDestroy {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(QUEUE_NAME, { connection: bullConnection() });
  }

  async enqueueCaptureProof(data: CaptureProofJob): Promise<void> {
    await this.queue.add('capture-proof', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 200,
      removeOnFail: 1_000,
      // IDEMPOTENCE : un seul job de capture par signature_request. Le webhook
      // ET la réconciliation peuvent l'enfiler ; BullMQ déduplique par jobId.
      jobId: `capture:${data.signatureRequestId}`,
    });
  }

  async enqueueSendReminder(data: SendReminderJob): Promise<void> {
    await this.queue.add('send-reminder', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
      // IDEMPOTENCE : un seul envoi enfilé par rappel et par passage. Le
      // marquage SENT en base est la garantie finale contre le doublon.
      jobId: `reminder:${data.reminderId}`,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
