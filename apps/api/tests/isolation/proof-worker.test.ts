import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import {
  JOB_QUEUE,
  type CaptureProofJob,
  type JobQueue,
  type SendReminderJob,
} from '../../src/jobs/job-queue.port.js';
import { ReconciliationService } from '../../src/jobs/reconciliation.service.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';

const SECRET = 'test-webhook-secret';

/**
 * File enregistreuse : capture les enfilements sans toucher Redis. C'est ce
 * que le producteur no-op remplace en prod par la vraie file BullMQ.
 */
class RecordingQueue implements JobQueue {
  readonly jobs: CaptureProofJob[] = [];
  readonly reminderJobs: SendReminderJob[] = [];
  async enqueueCaptureProof(data: CaptureProofJob): Promise<void> {
    this.jobs.push(data);
  }
  async enqueueSendReminder(data: SendReminderJob): Promise<void> {
    this.reminderJobs.push(data);
  }
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let queue: RecordingQueue;
let reconciliation: ReconciliationService;

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `${timestamp}.${digest}`;
}

function post(payload: unknown) {
  const body = JSON.stringify(payload);
  return request(app.getHttpServer())
    .post('/v1/webhooks/docuseal')
    .set('Content-Type', 'application/json')
    .set('X-Docuseal-Signature', sign(body))
    .send(body);
}

let sub: {
  contractId: string;
  requestId: string;
  submissionId: string;
  lsiSignerId: string;
  clientSignerId: string;
};

function formCompleted(externalId: string, submissionId: string) {
  return {
    event_type: 'form.completed',
    timestamp: '2026-07-18T10:00:00Z',
    data: {
      id: 2002,
      email: 'j.dupont@dupont.fr',
      external_id: externalId,
      status: 'completed',
      completed_at: '2026-07-18T10:00:00Z',
      submission: { id: Number(submissionId), status: 'completed' },
      metadata: {},
    },
  };
}

beforeAll(async () => {
  process.env.DOCUSEAL_WEBHOOK_SECRET = SECRET;

  queue = new RecordingQueue();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JOB_QUEUE)
    .useValue(queue)
    .compile();
  app = mod.createNestApplication({ rawBody: true });
  await app.init();

  reconciliation = mod.get(ReconciliationService);
  fx = await seedTwoCustomers();
});

/** Contrat neuf par test : LSI a déjà signé, le client est le dernier. */
beforeEach(async () => {
  queue.jobs.length = 0;

  const contractId = uuidv7();
  const requestId = uuidv7();
  const submissionId = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  const lsiSignerId = uuidv7();
  const clientSignerId = uuidv7();
  const now = new Date();

  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${contractId.slice(-12)}`,
        title: 'Contrat en signature',
        type: 'MAIN',
        status: 'PENDING_SIGNATURE',
        category: 'MAINTENANCE',
        currency: 'EUR',
        billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId,
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
        updatedByUserId: fx.amUserId,
      },
    });
    await tx.contractSigner.createMany({
      data: [
        {
          id: lsiSignerId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId,
          party: 'LSI',
          fullName: 'Marc D.',
          email: 'direction@lsi.fr',
          signingOrder: 0,
          status: 'SIGNED',
          signedAt: new Date('2026-07-18T09:00:00Z'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: clientSignerId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId,
          party: 'CLIENT',
          fullName: 'J. Dupont',
          email: 'j.dupont@dupont.fr',
          signingOrder: 1,
          status: 'SENT',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await tx.signatureRequest.create({
      data: {
        id: requestId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId,
        versionId: uuidv7(),
        provider: 'DOCUSEAL',
        providerSubmissionId: submissionId,
        status: 'SENT',
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
      },
    });
  });

  sub = { contractId, requestId, submissionId, lsiSignerId, clientSignerId };
});

// ===========================================================================
// W-05 — le webhook enfile la capture APRÈS complétion totale
// ===========================================================================

describe('W-05 — enfilement de la capture par le webhook', () => {
  test('complétion TOTALE → un job de capture, scope = celui de la request', async () => {
    const res = await post(formCompleted(sub.clientSignerId, sub.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toEqual({
      signatureRequestId: sub.requestId,
      tenantId: fx.tenantId,
      customerId: fx.customerA.id,
    });
  });

  test('complétion PARTIELLE → aucun job (rien à capturer encore)', async () => {
    // On remet LSI en attente : il reste une signature, donc pas COMPLETED.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractSigner.update({
        where: { id: sub.lsiSignerId },
        data: { status: 'SENT', signedAt: null },
      }),
    );

    const res = await post(formCompleted(sub.clientSignerId, sub.submissionId));
    expect(res.status).toBe(200);
    expect(queue.jobs).toHaveLength(0);
  });

  test('le rejeu (duplicate) n’enfile PAS un second job', async () => {
    const payload = formCompleted(sub.clientSignerId, sub.submissionId);
    await post(payload);
    await post(payload);
    // Le second est duplicate_ignored : pas de nouvel enfilement.
    expect(queue.jobs).toHaveLength(1);
  });
});

// ===========================================================================
// EC-06 — la réconciliation rattrape les captures oubliées
// ===========================================================================

describe('EC-06 — réconciliation', () => {
  test('une request COMPLETED sans preuve est réenfilée', async () => {
    // Simule un job de capture perdu : COMPLETED, mais signedPdfObjectKey nul.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.update({
        where: { id: sub.requestId },
        data: { status: 'COMPLETED' },
      }),
    );

    const n = await reconciliation.run();

    expect(n).toBeGreaterThanOrEqual(1);
    const mine = queue.jobs.filter((j) => j.signatureRequestId === sub.requestId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      signatureRequestId: sub.requestId,
      tenantId: fx.tenantId,
      customerId: fx.customerA.id,
    });
  });

  test('une request DÉJÀ capturée n’est pas réenfilée', async () => {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.update({
        where: { id: sub.requestId },
        data: { status: 'COMPLETED', signedPdfObjectKey: 'deja/capture.pdf' },
      }),
    );

    await reconciliation.run();

    const mine = queue.jobs.filter((j) => j.signatureRequestId === sub.requestId);
    expect(mine).toHaveLength(0);
  });

  test('une request encore SENT n’est pas réenfilée', async () => {
    // Reste SENT (pas COMPLETED) : la capture n'a pas lieu d'être.
    await reconciliation.run();
    const mine = queue.jobs.filter((j) => j.signatureRequestId === sub.requestId);
    expect(mine).toHaveLength(0);
  });
});
