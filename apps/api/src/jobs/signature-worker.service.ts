import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { systemScope } from '@lsi/persistence';
import { ProofCaptureService } from '../signature/proof-capture.service.js';
import { bullConnection } from './bullmq-job-queue.js';
import { QUEUE_NAME, type CaptureProofJob } from './job-queue.port.js';
import { ReconciliationService } from './reconciliation.service.js';

const RECONCILE_EVERY_MS = 60 * 60 * 1_000; // horaire

/**
 * Worker BullMQ embarqué. (§11.6, §12.3)
 *
 * NE DÉMARRE QUE si WORKER_ENABLED=true. Ainsi :
 *   - les tests d'API ne lancent aucune connexion Redis ni traitement de fond ;
 *   - en prod, un seul conteneur porte le drapeau (le worker est unique, la
 *     file distribue), les autres ne servent que l'API.
 *
 * Deux jobs :
 *   - capture-proof       : télécharge et stocke la preuve d'une signature.
 *   - reconcile-signatures: filet EC-06, réenfile les captures oubliées.
 */
@Injectable()
export class SignatureWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SignatureWorkerService.name);
  private worker?: Worker;
  private scheduler?: Queue;

  constructor(
    private readonly proof: ProofCaptureService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKER_ENABLED !== 'true') {
      this.log.log('worker désactivé (WORKER_ENABLED != true)');
      return;
    }

    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        switch (job.name) {
          case 'capture-proof': {
            const d = job.data as CaptureProofJob;
            await this.proof.capture(
              systemScope(d.tenantId, d.customerId),
              d.signatureRequestId,
              new Date(),
            );
            return;
          }
          case 'reconcile-signatures':
            await this.reconciliation.run();
            return;
          default:
            this.log.warn(`job inconnu ignoré : ${job.name}`);
        }
      },
      { connection: bullConnection(), concurrency: 4 },
    );

    this.worker.on('failed', (job, err) => {
      this.log.error(`job ${job?.name} #${job?.id} échoué : ${err.message}`);
    });

    // Réconciliation répétée. jobId fixe : une seule série programmée quel que
    // soit le nombre de redémarrages.
    this.scheduler = new Queue(QUEUE_NAME, { connection: bullConnection() });
    await this.scheduler.add(
      'reconcile-signatures',
      {},
      { repeat: { every: RECONCILE_EVERY_MS }, jobId: 'reconcile-hourly' },
    );

    this.log.log('worker démarré (capture-proof + réconciliation horaire)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.scheduler?.close();
  }
}
