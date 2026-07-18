import { Inject, Injectable, Logger } from '@nestjs/common';
import { findSignaturesNeedingProof } from '@lsi/persistence';
import { JOB_QUEUE, type JobQueue } from './job-queue.port.js';

/**
 * Réconciliation des preuves de signature. (EC-06, §11.6)
 *
 * Exécutée périodiquement par le worker. Retrouve les signatures complétées
 * dont la preuve n'a pas été capturée (job perdu) et réenfile la capture.
 * Idempotent de bout en bout : le jobId de capture déduplique, et
 * ProofCaptureService ne refait rien si l'empreinte existe déjà.
 *
 * C'est le filet : le webhook est l'optimisation de latence, la
 * réconciliation la garantie que rien n'est oublié.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);

  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  async run(): Promise<number> {
    const pending = await findSignaturesNeedingProof();
    for (const sr of pending) {
      await this.queue.enqueueCaptureProof({
        signatureRequestId: sr.id,
        tenantId: sr.tenantId,
        customerId: sr.customerId,
      });
    }
    if (pending.length > 0) {
      this.log.log(`réconciliation : ${pending.length} preuve(s) réenfilée(s)`);
    }
    return pending.length;
  }
}
