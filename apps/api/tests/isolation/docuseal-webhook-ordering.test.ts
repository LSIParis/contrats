import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { JOB_QUEUE, type CaptureProofJob, type JobQueue, type SendReminderJob } from '../../src/jobs/job-queue.port.js';
import { DocusealWebhookService } from '../../src/webhooks/docuseal-webhook.service.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { docusealSignature, fixtureResponse, fixtureText, loadFixture, stubFetch } from '../support/docuseal-fixtures.js';

/**
 * Webhooks DocuSeal : rejeu, désordre, refus, expiration, secret partagé,
 * réconciliation — rejoués depuis les FIXTURES de test/fixtures/docuseal/.
 *
 * DocuSeal réessaie 48 h et ne garantit pas l'ordre de livraison. L'état
 * final d'une demande ne doit dépendre ni du nombre de livraisons ni de
 * leur ordre : c'est ce que ces tests fixent.
 *
 * Parcours de référence : ordre du brief, CLIENT puis LSI, les deux
 * signataires invités (SENT) au départ.
 */

const SECRET = 'test-webhook-secret';

class RecordingQueue implements JobQueue {
  readonly jobs: CaptureProofJob[] = [];
  async enqueueCaptureProof(data: CaptureProofJob): Promise<void> {
    this.jobs.push(data);
  }
  async enqueueSendReminder(_data: SendReminderJob): Promise<void> {}
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let queue: RecordingQueue;
let s: { contractId: string; requestId: string; submissionId: number; clientSignerId: string; lsiSignerId: string };

const vars = () => ({
  SUBMISSION_ID: s.submissionId,
  CLIENT_SIGNER_ID: s.clientSignerId,
  LSI_SIGNER_ID: s.lsiSignerId,
  TENANT_ID: fx.tenantId,
  CUSTOMER_ID: fx.customerA.id,
  CONTRACT_ID: s.contractId,
  SIGNATURE_REQUEST_ID: s.requestId,
});

function postRaw(body: string, extraHeaders: Record<string, string> = {}) {
  let req = request(app.getHttpServer())
    .post('/v1/webhooks/docuseal')
    .set('Content-Type', 'application/json')
    .set('X-Docuseal-Signature', docusealSignature(SECRET, body));
  for (const [k, v] of Object.entries(extraHeaders)) req = req.set(k, v);
  return req.send(body);
}

const postFixture = (name: string) => postRaw(fixtureText(name, vars()));

/** Rejoue une séquence de livraisons ; renvoie les statuts métier. */
async function replay(name: string): Promise<string[]> {
  const seq = loadFixture<{ deliveries: unknown[] }>(name, vars());
  const out: string[] = [];
  for (const d of seq.deliveries) {
    const res = await postRaw(JSON.stringify(d));
    expect(res.status).toBe(200);
    out.push(res.body.status);
  }
  return out;
}

const admin = () => adminScope(fx.tenantId, fx.adminUserId);

async function state() {
  return withScope(admin(), async (tx) => ({
    contract: await tx.contract.findUnique({ where: { id: s.contractId } }),
    request: await tx.signatureRequest.findUnique({ where: { id: s.requestId } }),
    client: await tx.contractSigner.findUnique({ where: { id: s.clientSignerId } }),
    lsi: await tx.contractSigner.findUnique({ where: { id: s.lsiSignerId } }),
    events: await tx.signatureEvent.count({ where: { signatureRequestId: s.requestId } }),
  }));
}

beforeAll(async () => {
  process.env.DOCUSEAL_WEBHOOK_SECRET = SECRET;
  queue = new RecordingQueue();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JOB_QUEUE)
    .useValue(queue)
    .compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
});

beforeEach(async () => {
  queue.jobs.length = 0;
  const now = new Date();
  s = {
    contractId: uuidv7(),
    requestId: uuidv7(),
    submissionId: Math.floor(Math.random() * 9_000_000) + 1_000_000,
    clientSignerId: uuidv7(),
    lsiSignerId: uuidv7(),
  };

  await withScope(admin(), async (tx) => {
    await tx.contract.create({
      data: {
        id: s.contractId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${s.contractId.slice(-12)}`,
        title: 'Contrat en signature (fixtures)',
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
    const signerBase = { tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: s.contractId, status: 'SENT' as const, createdAt: now, updatedAt: now };
    await tx.contractSigner.createMany({
      data: [
        { ...signerBase, id: s.clientSignerId, party: 'CLIENT', fullName: 'J. Dupont', email: 'j.dupont@client.example.test', signingOrder: 0 },
        { ...signerBase, id: s.lsiSignerId, party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.example.test', signingOrder: 1 },
      ],
    });
    await tx.signatureRequest.create({
      data: {
        id: s.requestId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId: s.contractId,
        versionId: uuidv7(),
        provider: 'DOCUSEAL',
        providerSubmissionId: String(s.submissionId),
        status: 'SENT',
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
      },
    });
  });
});

afterEach(() => {
  delete process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET;
  vi.unstubAllGlobals();
});

describe('chaque événement documenté est accepté (fixtures valides)', () => {
  test.each([
    'webhook.form-viewed.json',
    'webhook.form-started.json',
    'webhook.form-completed.client.json',
    'webhook.form-declined.json',
    'webhook.submission-completed.json',
    'webhook.submission-expired.json',
  ])('%s → 200 processed', async (name) => {
    const res = await postFixture(name);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
  });
});

describe('rejeu (EC-05)', () => {
  test('le même corps livré deux fois : un seul événement, un seul effet', async () => {
    expect(await replay('webhook-sequence.replayed.json')).toEqual(['processed', 'duplicate_ignored']);
    const st = await state();
    expect(st.events).toBe(1);
    expect(st.client!.status).toBe('SIGNED');
    expect(st.request!.status).toBe('PARTIALLY_COMPLETED');
    expect(st.contract!.status).toBe('PARTIALLY_SIGNED');
  });

  test('form.completed réémis avec un AUTRE horodatage : journalisé, signedAt inchangé', async () => {
    await postFixture('webhook.form-completed.client.json');
    const before = (await state()).client!.signedAt;

    const again = loadFixture('webhook.form-completed.client.json', vars());
    again.timestamp = '2026-09-27T09:30:00Z';
    const res = await postRaw(JSON.stringify(again));
    expect(res.body.status).toBe('processed');

    const st = await state();
    expect(st.events).toBe(2);
    expect(st.client!.signedAt).toEqual(before);
    expect(st.contract!.status).toBe('PARTIALLY_SIGNED');
  });
});

describe('désordre', () => {
  test('submission.completed AVANT les form.completed, puis form.viewed tardif : SIGNÉ, sans régression', async () => {
    const outcomes = await replay('webhook-sequence.out-of-order.json');
    // submission.completed fait foi ; tout ce qui suit trouve la demande close.
    expect(outcomes).toEqual(['processed', 'closed_ignored', 'closed_ignored', 'closed_ignored']);

    const st = await state();
    expect(st.request!.status).toBe('COMPLETED');
    expect(st.contract!.status).toBe('SIGNED');
    expect(st.client!.status).toBe('SIGNED');
    expect(st.lsi!.status).toBe('SIGNED');
    expect(st.events).toBe(4); // tout est journalisé, même l'inerte
    // Une seule capture de preuve enfilée.
    expect(queue.jobs.filter((j) => j.signatureRequestId === s.requestId)).toHaveLength(1);
  });

  test('form.viewed APRÈS la signature du client : le signataire reste SIGNED', async () => {
    await postFixture('webhook.form-completed.client.json');
    const res = await postFixture('webhook.form-viewed.json');
    expect(res.body.status).toBe('processed');
    expect((await state()).client!.status).toBe('SIGNED');
  });

  test('form.completed LSI puis client (inverse de l’ordre prévu) : SIGNÉ, une capture', async () => {
    await postFixture('webhook.form-completed.lsi.json');
    await postFixture('webhook.form-completed.client.json');
    const st = await state();
    expect(st.contract!.status).toBe('SIGNED');
    expect(st.request!.status).toBe('COMPLETED');
    expect(queue.jobs.filter((j) => j.signatureRequestId === s.requestId)).toHaveLength(1);
  });

  test('form.declined APRÈS la signature du même signataire : ignoré, la signature tient', async () => {
    await postFixture('webhook.form-completed.client.json');
    await postFixture('webhook.form-declined.json');
    const st = await state();
    expect(st.client!.status).toBe('SIGNED');
    expect(st.request!.status).toBe('PARTIALLY_COMPLETED');
    expect(st.contract!.status).toBe('PARTIALLY_SIGNED');
  });
});

describe('refus et expiration', () => {
  test('refus : contrat DECLINED avec motif ; le form.viewed rejoué ensuite ne rouvre rien', async () => {
    expect(await replay('webhook-sequence.declined.json')).toEqual(['processed', 'processed', 'duplicate_ignored']);
    const st = await state();
    expect(st.request!.status).toBe('DECLINED');
    expect(st.contract!.status).toBe('DECLINED');
    expect(st.client!.status).toBe('DECLINED');
    expect(st.client!.declineReason).toContain('annexe 2');
  });

  test('expiration : demande EXPIRED ; un form.completed tardif est inerte', async () => {
    expect(await replay('webhook-sequence.expired.json')).toEqual(['processed', 'processed', 'closed_ignored']);
    const st = await state();
    expect(st.request!.status).toBe('EXPIRED');
    expect(st.client!.status).toBe('VIEWED');
    // Brief §2 : EN_SIGNATURE → SIGNATURE_EXPIRÉE (v2).
    expect(st.contract!.status).toBe('SIGNATURE_EXPIRED');
  });
});

describe('secret partagé optionnel (DOCUSEAL_WEBHOOK_HEADER_SECRET)', () => {
  test('configuré : sans l’en-tête → 401 et rien d’écrit ; avec → 200', async () => {
    process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET = 'partage-123';
    const body = fixtureText('webhook.form-viewed.json', vars());

    expect((await postRaw(body)).status).toBe(401);
    expect((await postRaw(body, { 'X-Docuseal-Webhook-Secret': 'faux' })).status).toBe(401);
    expect((await state()).events).toBe(0);

    const ok = await postRaw(body, { 'X-Docuseal-Webhook-Secret': 'partage-123' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('processed');
  });
});

describe('réconciliation sans webhook (GET /submissions/{id})', () => {
  test('submission complétée chez DocuSeal, aucun webhook reçu → contrat SIGNÉ, idempotent', async () => {
    process.env.DOCUSEAL_API_KEY = 'test-token';
    process.env.DOCUSEAL_URL = 'https://signe.example.test/api';
    try {
      stubFetch([
        {
          match: `https://signe.example.test/api/submissions/${s.submissionId}`,
          reply: () => fixtureResponse('get-submission.completed.json', vars()),
        },
      ]);
      const service = app.get(DocusealWebhookService);

      const first = await service.reconcileFromProvider(String(s.submissionId));
      expect(first).toContain('processed');
      let st = await state();
      expect(st.contract!.status).toBe('SIGNED');
      expect(st.request!.status).toBe('COMPLETED');
      expect(queue.jobs.filter((j) => j.signatureRequestId === s.requestId)).toHaveLength(1);

      // Seconde passe : tout est dédupliqué, rien ne bouge.
      const second = await service.reconcileFromProvider(String(s.submissionId));
      expect(second.every((o) => o === 'duplicate_ignored')).toBe(true);

      // Le vrai webhook arrive enfin : journalisé, sans effet.
      const late = await postFixture('webhook.submission-completed.json');
      expect(late.body.status).toBe('closed_ignored');
      st = await state();
      expect(st.contract!.status).toBe('SIGNED');
    } finally {
      delete process.env.DOCUSEAL_API_KEY;
      delete process.env.DOCUSEAL_URL;
    }
  });
});
