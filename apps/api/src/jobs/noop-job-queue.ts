import { Injectable, Logger } from '@nestjs/common';
import type { CaptureProofJob, JobQueue, SendReminderJob } from './job-queue.port.js';

/**
 * File no-op — tests et processus sans worker configuré.
 *
 * N'ouvre aucune connexion Redis : les tests d'API ne démarrent pas de
 * plomberie BullMQ. L'enfilement est journalisé et ignoré.
 */
@Injectable()
export class NoOpJobQueue implements JobQueue {
  private readonly log = new Logger(NoOpJobQueue.name);

  async enqueueCaptureProof(data: CaptureProofJob): Promise<void> {
    this.log.debug(`enqueueCaptureProof ignoré (no-op) : ${data.signatureRequestId}`);
  }

  async enqueueSendReminder(data: SendReminderJob): Promise<void> {
    this.log.debug(`enqueueSendReminder ignoré (no-op) : ${data.reminderId}`);
  }
}
