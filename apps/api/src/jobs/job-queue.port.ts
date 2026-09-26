export const JOB_QUEUE = Symbol('JOB_QUEUE');

export const QUEUE_NAME = 'lsi-jobs';

export interface CaptureProofJob {
  signatureRequestId: string;
  tenantId: string;
  customerId: string;
}

export interface SendReminderJob {
  reminderId: string;
  tenantId: string;
  customerId: string;
}

/**
 * Producteur de jobs. (§11.6, §12.3)
 *
 * Abstrait BullMQ : les services enfilent des jobs sans connaître Redis. En
 * test, une implémentation no-op (ou un fake) évite toute connexion.
 */
export interface ImportOcrJob {
  importId: string;
  tenantId: string;
  customerId: string;
}

export interface JobQueue {
  enqueueCaptureProof(data: CaptureProofJob): Promise<void>;
  enqueueSendReminder(data: SendReminderJob): Promise<void>;
  /** OCR + extraction d'un contrat importé (03-import-existant §3). */
  enqueueImportOcr(data: ImportOcrJob): Promise<void>;
}
