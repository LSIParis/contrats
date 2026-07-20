import { describe, test, expect, beforeEach, vi } from 'vitest';

/**
 * Régression : BullMQ v5 REFUSE tout `jobId` custom contenant « : »
 * (il s'en sert comme séparateur de clés Redis) — il lève
 * « Custom Id cannot contain : ». Nos jobId `capture:<id>` / `reminder:<id>`
 * échouaient donc à l'enfilement EN PRODUCTION, sans jamais capturer la
 * preuve signée ni envoyer les rappels.
 *
 * Les tests worker/capture existants passaient parce qu'ils utilisent une
 * fake queue : le vrai BullMQ, seul à porter cette contrainte, n'était jamais
 * exercé. Ce test-ci vise précisément le producteur réel `BullMqJobQueue`, en
 * interceptant `Queue.add` pour vérifier la SEULE propriété que BullMQ exige :
 * pas de « : » dans le jobId.
 */

const added: Array<{ name: string; data: unknown; opts: { jobId?: string } }> = [];

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(_name: string, _opts: unknown) {}
    async add(name: string, data: unknown, opts: { jobId?: string }) {
      // Reproduit la validation réelle de BullMQ v5.
      if (opts.jobId && opts.jobId.includes(':')) {
        throw new Error('Custom Id cannot contain :');
      }
      added.push({ name, data, opts });
    }
    async close() {}
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(_url: string, _opts: unknown) {}
  },
}));

import { BullMqJobQueue } from '../../src/jobs/bullmq-job-queue.js';

beforeEach(() => {
  added.length = 0;
  process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('BullMqJobQueue — jobId sans « : » (contrainte BullMQ v5)', () => {
  test('enqueueCaptureProof enfile un jobId sans « : »', async () => {
    const q = new BullMqJobQueue();
    await q.enqueueCaptureProof({ signatureRequestId: 'sr-1', tenantId: 't-1', customerId: 'c-1' });
    expect(added).toHaveLength(1);
    expect(added[0]!.opts.jobId).toBeDefined();
    expect(added[0]!.opts.jobId).not.toContain(':');
    // Toujours idempotent par signature_request.
    expect(added[0]!.opts.jobId).toContain('sr-1');
  });

  test('enqueueSendReminder enfile un jobId sans « : »', async () => {
    const q = new BullMqJobQueue();
    await q.enqueueSendReminder({ reminderId: 'rem-1', tenantId: 't-1', customerId: 'c-1' });
    expect(added).toHaveLength(1);
    expect(added[0]!.opts.jobId).not.toContain(':');
    expect(added[0]!.opts.jobId).toContain('rem-1');
  });
});
