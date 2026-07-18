import { Inject, Injectable, Logger } from '@nestjs/common';
import { findDueReminders } from '@lsi/persistence';
import { JOB_QUEUE, type JobQueue } from './job-queue.port.js';

/**
 * Dispatch des rappels dus. (§12.3, UC-08)
 *
 * Découvre les rappels PENDING échus (rôle scheduler borné) et enfile un job
 * d'envoi par rappel. Ne fait RIEN d'autre : la décision d'envoi (interne
 * seule, +client, +escalade) et le marquage SENT se font dans le processeur,
 * sous scope résolu.
 *
 * Séparer découverte et envoi n'est pas cosmétique : la découverte est la
 * seule requête hors scope, on la garde minuscule et confinée au rôle
 * scheduler ; l'envoi manipule contrats et emails, sous lsi_app.
 */
@Injectable()
export class ReminderDispatchService {
  private readonly log = new Logger(ReminderDispatchService.name);

  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  async run(): Promise<number> {
    const due = await findDueReminders();
    for (const r of due) {
      await this.queue.enqueueSendReminder({
        reminderId: r.id,
        tenantId: r.tenantId,
        customerId: r.customerId,
      });
    }
    if (due.length > 0) this.log.log(`dispatch : ${due.length} rappel(s) enfilé(s)`);
    return due.length;
  }
}
