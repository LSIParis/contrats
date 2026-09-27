import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_NAME,
  type CaptureProofJob,
  type ImportOcrJob,
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
      // Séparateur « - » et NON « : » : BullMQ v5 refuse un jobId contenant
      // « : » (« Custom Id cannot contain : ») — il s'en sert comme séparateur
      // de clés Redis. Un « : » ici faisait échouer TOUT enfilement en prod.
      jobId: `capture-${data.signatureRequestId}`,
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
      // Séparateur « - » (jamais « : ») : cf. enqueueCaptureProof — BullMQ v5
      // rejette un jobId contenant « : ».
      jobId: `reminder-${data.reminderId}`,
    });
  }

  async enqueueImportOcr(data: ImportOcrJob): Promise<void> {
    await this.queue.add('import-ocr', data, {
      // Les nouvelles tentatives sont gérées par ImportsService (compteur en
      // base, 3 essais) : BullMQ ne réessaie pas en plus, sinon on compterait
      // double et l'état en base divergerait de l'état de la file.
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 1_000,
      // Un OCR par import et par tentative : un double enfilement est dédoublonné.
      jobId: `ocr-${data.importId}-${Date.now()}`,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
