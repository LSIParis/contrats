import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { systemScope } from '@lsi/persistence';
import { ProofCaptureService } from '../signature/proof-capture.service.js';
import { bullConnection } from './bullmq-job-queue.js';
import { QUEUE_NAME, type CaptureProofJob, type SendReminderJob } from './job-queue.port.js';
import { ReconciliationService } from './reconciliation.service.js';
import { LifecycleService } from './lifecycle.service.js';
import { ReminderDispatchService } from './reminder-dispatch.service.js';
import { ReminderSendService } from './reminder-send.service.js';

const RECONCILE_EVERY_MS = 60 * 60 * 1_000; // horaire
const LIFECYCLE_EVERY_MS = 24 * 60 * 60 * 1_000; // quotidien
const DISPATCH_EVERY_MS = 24 * 60 * 60 * 1_000; // quotidien (UC-08)

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
 *   - lifecycle-sweep     : active/expire les contrats à échéance (RM-06/07)
 *     et matérialise les rappels (RM-23).
 *   - dispatch-reminders  : découvre les rappels dus et enfile leurs envois.
 *   - send-reminder       : envoie un rappel (interne / client / escalade).
 */
@Injectable()
export class SignatureWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SignatureWorkerService.name);
  private worker?: Worker;
  private scheduler?: Queue;

  constructor(
    private readonly proof: ProofCaptureService,
    private readonly reconciliation: ReconciliationService,
    private readonly lifecycle: LifecycleService,
    private readonly dispatch: ReminderDispatchService,
    private readonly reminderSend: ReminderSendService,
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
          case 'lifecycle-sweep':
            await this.lifecycle.run(new Date());
            return;
          case 'dispatch-reminders':
            await this.dispatch.run();
            return;
          case 'send-reminder': {
            const d = job.data as SendReminderJob;
            await this.reminderSend.send(
              systemScope(d.tenantId, d.customerId),
              d.reminderId,
              new Date(),
            );
            return;
          }
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
    await this.scheduler.add(
      'lifecycle-sweep',
      {},
      { repeat: { every: LIFECYCLE_EVERY_MS }, jobId: 'lifecycle-daily' },
    );
    await this.scheduler.add(
      'dispatch-reminders',
      {},
      { repeat: { every: DISPATCH_EVERY_MS }, jobId: 'dispatch-daily' },
    );

    this.log.log('worker démarré (capture + réconciliation + cycle de vie + rappels)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.scheduler?.close();
  }
}
