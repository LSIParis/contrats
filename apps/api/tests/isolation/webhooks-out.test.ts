import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { LifecycleService } from '../../src/jobs/lifecycle.service.js';
import { WebhookDeliveryService } from '../../src/webhooks-out/webhook-delivery.service.js';
import { verifyWebhookSignature } from '../../src/webhooks-out/signature.js';
import { adminScope, internalScope, clientScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Webhooks sortants de bout en bout (lot 5), sans réseau externe : un
 * serveur HTTP local (127.0.0.1) joue le consommateur, d'où
 * WEBHOOKS_ALLOW_PRIVATE=true pour ce fichier.
 *
 * Couvre : secret montré une seule fois et stocké chiffré, en-têtes et
 * signature vérifiables, reprise sur 500 puis succès, désactivation
 * automatique après N DEAD (audit), isolation entre tenants, rôles, et la
 * production d'un `contract.terminated` par une vraie transition de cycle de vie.
 */
let app: INestApplication;
let t1: TwoCustomerFixture;
let t2: TwoCustomerFixture;
let delivery: WebhookDeliveryService;

interface Received { url: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let received: Received[] = [];
let responses: number[] = []; // file de statuts à renvoyer ; vide → 200
let hookUrl: string;

const PREV_ALLOW = process.env.WEBHOOKS_ALLOW_PRIVATE;

beforeAll(async () => {
  process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(responses.shift() ?? 200).end('merci');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/contrats`;

  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  delivery = app.get(WebhookDeliveryService);
  t1 = await seedTwoCustomers();
  t2 = await seedTwoCustomers(); // un SECOND tenant, pour l'isolation
  const s = app.get(SessionService);
  await s.put({ sessionId: 'wh-admin-1', userId: t1.adminUserId, tenantId: t1.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t1.tenantId, t1.adminUserId) });
  await s.put({ sessionId: 'wh-admin-2', userId: t2.adminUserId, tenantId: t2.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t2.tenantId, t2.adminUserId) });
  await s.put({ sessionId: 'wh-am-1', userId: t1.amUserId, tenantId: t1.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(t1.tenantId, [t1.customerA.id], t1.amUserId) });
  await s.put({ sessionId: 'wh-client-1', userId: t1.customerA.clientUserId, tenantId: t1.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(t1.tenantId, t1.customerA.id, t1.customerA.clientUserId) });
});

afterAll(async () => {
  process.env.WEBHOOKS_ALLOW_PRIVATE = PREV_ALLOW;
  delete process.env.WEBHOOKS_DISABLE_AFTER_DEAD;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  received = [];
  responses = [];
});

const http_ = () => request(app.getHttpServer());

async function createSub(eventTypes: string[] = ['contract.terminated'], sess = 'wh-admin-1') {
  const res = await http_().post('/v1/admin/webhooks').set('x-lsi-session', sess)
    .send({ url: hookUrl, description: 'ERP de test', eventTypes }).expect(201);
  return res.body as { id: string; secret: string; secretHint: string };
}

// `any` assumé : lecture de vérification, les types Prisma n’apportent rien ici.
const asAdmin1 = (fn: (tx: any) => Promise<any>): Promise<any> => withScope(adminScope(t1.tenantId, t1.adminUserId), fn);

describe('création et secret', () => {
  test('le secret est montré UNE fois, puis jamais ; il est stocké chiffré', async () => {
    const sub = await createSub();
    expect(sub.secret).toMatch(/^whsec_/);
    expect(sub.secretHint).toBe(sub.secret.slice(-4));
    expect(sub).not.toHaveProperty('secretCiphertext');

    const list = await http_().get('/v1/admin/webhooks').set('x-lsi-session', 'wh-admin-1').expect(200);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain(sub.secret);
    expect(raw).not.toContain('secretCiphertext');
    expect(list.body.eventTypes).toContain('contract.terminated');
    expect(list.body.subscriptions.find((s: any) => s.id === sub.id)).toMatchObject({ active: true, url: hookUrl });

    const row = await asAdmin1((tx) => tx.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } }));
    expect(row.secretCiphertext).not.toContain(sub.secret);
    expect(row.secretCiphertext).not.toContain(sub.secret.slice(6));
    expect(row.secretKeyVersion).toBe(1);

    const del = await http_().get(`/v1/admin/webhooks/${sub.id}/deliveries`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(JSON.stringify(del.body)).not.toContain(sub.secret);
  });

  test('entrées refusées : type inconnu, champ inconnu, URL privée hors WEBHOOKS_ALLOW_PRIVATE', async () => {
    await http_().post('/v1/admin/webhooks').set('x-lsi-session', 'wh-admin-1')
      .send({ url: 'https://erp.example.com/h', eventTypes: ['contract.nimporte'] }).expect(400);
    await http_().post('/v1/admin/webhooks').set('x-lsi-session', 'wh-admin-1')
      .send({ url: 'https://erp.example.com/h', eventTypes: ['contract.signed'], tenantId: t2.tenantId }).expect(400);
    process.env.WEBHOOKS_ALLOW_PRIVATE = 'false';
    try {
      for (const url of ['http://erp.example.com/h', 'https://127.0.0.1/h', 'https://localhost/h', 'https://10.0.0.5/h']) {
        await http_().post('/v1/admin/webhooks').set('x-lsi-session', 'wh-admin-1')
          .send({ url, eventTypes: ['contract.signed'] }).expect(400);
      }
    } finally {
      process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
    }
  });

  test('rotation : nouveau secret montré une fois ; les livraisons suivantes le portent', async () => {
    const sub = await createSub();
    const rot = await http_().post(`/v1/admin/webhooks/${sub.id}/rotate-secret`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(rot.body.secret).toMatch(/^whsec_/);
    expect(rot.body.secret).not.toBe(sub.secret);
    await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);
    const r = received.at(-1)!;
    const check = (secret: string) => verifyWebhookSignature({
      secret, rawBody: r.body,
      signatureHeader: r.headers['x-contrats-signature'] as string,
      timestampHeader: r.headers['x-contrats-timestamp'] as string,
    });
    expect(check(rot.body.secret)).toEqual({ ok: true });
    expect(check(sub.secret).ok).toBe(false);
  });
});

describe('livraison', () => {
  test('ping : en-têtes, corps et signature vérifiables par le consommateur', async () => {
    const sub = await createSub(['contract.signed']);
    const res = await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(res.body.outcome).toBe('DELIVERED');
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.url).toBe('/hooks/contrats');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['x-contrats-event']).toBe('ping');
    expect(r.headers['x-contrats-delivery']).toBe(res.body.deliveryId);
    const ts = Number(r.headers['x-contrats-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(60);
    expect(r.headers['x-contrats-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({
      secret: sub.secret, rawBody: r.body,
      signatureHeader: r.headers['x-contrats-signature'] as string,
      timestampHeader: r.headers['x-contrats-timestamp'] as string,
    })).toEqual({ ok: true });
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ type: 'ping', data: { subscriptionId: sub.id, message: 'ping' } });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    const d = await asAdmin1((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: res.body.deliveryId } }));
    expect(d).toMatchObject({ status: 'DELIVERED', attempt: 1, responseStatus: 200, nextAttemptAt: null });
    expect(d.responseMs).toBeGreaterThanOrEqual(0);
  });

  test('500 → FAILED avec reprise à +1 min ; la reprise réussit (même livraison, même événement)', async () => {
    const sub = await createSub(['contract.signed']);
    responses = [500];
    const res = await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(res.body.outcome).toBe('FAILED');
    const failed = await asAdmin1((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: res.body.deliveryId } }));
    expect(failed).toMatchObject({ status: 'FAILED', attempt: 1, responseStatus: 500 });
    expect(failed.lastError).toContain('HTTP 500');
    const delay = failed.nextAttemptAt!.getTime() - failed.updatedAt.getTime();
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThanOrEqual(61_000);

    // Pas encore dû : rien n'est envoyé.
    expect(await delivery.attempt(t1.tenantId, res.body.deliveryId, new Date())).toBe('SKIPPED');
    // Échéance passée : la reprise part et réussit.
    const later = new Date(failed.nextAttemptAt!.getTime() + 1_000);
    expect(await delivery.attempt(t1.tenantId, res.body.deliveryId, later)).toBe('DELIVERED');
    expect(received).toHaveLength(2);
    expect(received[1]!.headers['x-contrats-delivery']).toBe(received[0]!.headers['x-contrats-delivery']);
    expect(JSON.parse(received[1]!.body).id).toBe(JSON.parse(received[0]!.body).id);
    const ok = await asAdmin1((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: res.body.deliveryId } }));
    expect(ok).toMatchObject({ status: 'DELIVERED', attempt: 2, lastError: null });

    const list = await http_().get(`/v1/admin/webhooks/${sub.id}/deliveries`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(list.body.deliveries[0]).toMatchObject({ id: res.body.deliveryId, status: 'DELIVERED', attempt: 2, event: { type: 'ping' } });
  });

  test('redirection (302) = échec, jamais suivie', async () => {
    const sub = await createSub(['contract.signed']);
    responses = [302];
    const res = await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(res.body.outcome).toBe('FAILED');
    expect(received).toHaveLength(1);
    const d = await asAdmin1((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: res.body.deliveryId } }));
    expect(d.lastError).toContain('redirection non suivie');
  });

  test('après N livraisons DEAD consécutives, l’abonnement est désactivé et l’audit le trace', async () => {
    process.env.WEBHOOKS_DISABLE_AFTER_DEAD = '2';
    try {
      const sub = await createSub(['contract.signed']);
      const exhaust = async () => {
        responses = Array(10).fill(500);
        const res = await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);
        let outcome = res.body.outcome as string;
        let now = Date.now();
        // Tentatives 2..6 aux échéances successives (1 min … 12 h) : horloge avancée.
        for (let i = 0; i < 5; i++) {
          now += 13 * 60 * 60_000;
          outcome = await delivery.attempt(t1.tenantId, res.body.deliveryId, new Date(now));
        }
        return { outcome, deliveryId: res.body.deliveryId as string };
      };
      const first = await exhaust();
      expect(first.outcome).toBe('DEAD');
      let row = await asAdmin1((tx) => tx.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } }));
      expect(row).toMatchObject({ active: true, consecutiveFailures: 1 });
      const dead = await asAdmin1((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: first.deliveryId } }));
      expect(dead).toMatchObject({ status: 'DEAD', attempt: 6, nextAttemptAt: null });

      const second = await exhaust();
      expect(second.outcome).toBe('DEAD');
      row = await asAdmin1((tx) => tx.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } }));
      expect(row.active).toBe(false);
      expect(row.disabledAt).not.toBeNull();
      expect(row.disabledReason).toMatch(/automatiquement/);

      const audit = await asAdmin1((tx) =>
        tx.auditLog.findMany({ where: { action: 'webhook.subscription.auto_disabled', resourceId: sub.id } }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorKind: 'SYSTEM' });

      // Désactivé : ni test ni relivraison ; réactivation → compteur remis à zéro.
      await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(409);
      await http_().post(`/v1/admin/webhook-deliveries/${second.deliveryId}/redeliver`).set('x-lsi-session', 'wh-admin-1').expect(409);
      const en = await http_().post(`/v1/admin/webhooks/${sub.id}/enable`).set('x-lsi-session', 'wh-admin-1').expect(200);
      expect(en.body).toMatchObject({ active: true, consecutiveFailures: 0, disabledAt: null });

      // Relivraison manuelle d'une livraison morte : nouvelle série, succès.
      responses = [];
      const re = await http_().post(`/v1/admin/webhook-deliveries/${second.deliveryId}/redeliver`).set('x-lsi-session', 'wh-admin-1').expect(200);
      expect(re.body.outcome).toBe('DELIVERED');
    } finally {
      delete process.env.WEBHOOKS_DISABLE_AFTER_DEAD;
    }
  });

  test('désactivation manuelle : plus de livraison pour cet abonnement', async () => {
    const sub = await createSub(['contract.signed']);
    const dis = await http_().post(`/v1/admin/webhooks/${sub.id}/disable`).set('x-lsi-session', 'wh-admin-1').expect(200);
    expect(dis.body).toMatchObject({ active: false });
    expect(dis.body.disabledAt).toBeTruthy();
    await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(409);
  });
});

describe('isolation multi-tenant et rôles', () => {
  test('le tenant 2 ne voit, ne modifie ni ne relivre rien du tenant 1 (404)', async () => {
    const sub = await createSub(['contract.signed']);
    const ping = await http_().post(`/v1/admin/webhooks/${sub.id}/test`).set('x-lsi-session', 'wh-admin-1').expect(200);

    const list = await http_().get('/v1/admin/webhooks').set('x-lsi-session', 'wh-admin-2').expect(200);
    expect(list.body.subscriptions.map((s: any) => s.id)).not.toContain(sub.id);
    for (const path of ['disable', 'enable', 'rotate-secret', 'test']) {
      await http_().post(`/v1/admin/webhooks/${sub.id}/${path}`).set('x-lsi-session', 'wh-admin-2').expect(404);
    }
    await http_().get(`/v1/admin/webhooks/${sub.id}/deliveries`).set('x-lsi-session', 'wh-admin-2').expect(404);
    await http_().post(`/v1/admin/webhook-deliveries/${ping.body.deliveryId}/redeliver`).set('x-lsi-session', 'wh-admin-2').expect(404);

    const row = await asAdmin1((tx) => tx.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } }));
    expect(row.active).toBe(true);
  });

  test('un commercial et un client n’ont pas accès (403)', async () => {
    for (const sess of ['wh-am-1', 'wh-client-1']) {
      await http_().get('/v1/admin/webhooks').set('x-lsi-session', sess).expect(403);
      await http_().post('/v1/admin/webhooks').set('x-lsi-session', sess)
        .send({ url: hookUrl, eventTypes: ['contract.signed'] }).expect(403);
    }
  });
});

describe('producteur : cycle de vie → contract.terminated', () => {
  test('TERMINATION_PENDING → TERMINATED publie l’événement dans la transaction, puis il est livré', async () => {
    const sub = await createSub(['contract.terminated']);
    const other = await createSub(['contract.signed']); // n'écoute pas ce type
    const id = uuidv7();
    const vId = uuidv7();
    const now = new Date();
    const today = new Date(now.toISOString().slice(0, 10));
    await asAdmin1(async (tx) => {
      await tx.contract.create({ data: {
        id, tenantId: t1.tenantId, customerId: t1.customerA.id, reference: `LSI-WH-${id.slice(-8)}`,
        title: 'Contrat de M. Dupont', type: 'MAIN', status: 'TERMINATION_PENDING', category: 'MAINTENANCE',
        currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: t1.amUserId, amountCents: 120000n,
        currentVersionId: vId, approvedVersionId: vId, noticePeriodDays: 30,
        startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'), terminationEffectiveDate: today,
        signedAt: now, activatedAt: now,
        createdAt: now, updatedAt: now, createdByUserId: t1.amUserId, updatedByUserId: t1.amUserId,
      } });
      await tx.contractVersion.create({ data: { id: vId, tenantId: t1.tenantId, customerId: t1.customerA.id, contractId: id, versionNumber: 1, bodyHtml: '<p>x</p>', variables: {}, createdAt: now, createdByUserId: t1.amUserId } });
    });

    await app.get(LifecycleService).run(new Date());

    const events = await asAdmin1((tx) => tx.webhookEvent.findMany({ where: { resourceId: id }, include: { deliveries: true } }));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ type: 'contract.terminated', customerId: t1.customerA.id });
    // Une livraison par abonnement ACTIF qui écoute ce type (ceux des tests
    // précédents inclus), aucune pour celui qui ne l'écoute pas.
    const subs = ev.deliveries.map((d: any) => d.subscriptionId);
    expect(subs).toContain(sub.id);
    expect(subs).not.toContain(other.id);
    expect(new Set(subs).size).toBe(subs.length);
    // Minimisation : ni titre (nom de personne), ni montant.
    const payload = JSON.stringify(ev.payload);
    expect(payload).not.toContain('Dupont');
    expect(payload).not.toContain('120000');
    expect(ev.payload).toMatchObject({
      contract: { id, status: 'TERMINATED', previousStatus: 'TERMINATION_PENDING', customerId: t1.customerA.id, startDate: '2026-01-01' },
    });

    const mine = ev.deliveries.find((d: any) => d.subscriptionId === sub.id)!;
    const outcome = await delivery.attempt(t1.tenantId, mine.id, new Date(), { force: true });
    expect(outcome).toBe('DELIVERED');
    const r = received.at(-1)!;
    expect(r.headers['x-contrats-event']).toBe('contract.terminated');
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ id: ev.id, type: 'contract.terminated', data: { contract: { id, status: 'TERMINATED' } } });
    expect(verifyWebhookSignature({
      secret: sub.secret, rawBody: r.body,
      signatureHeader: r.headers['x-contrats-signature'] as string,
      timestampHeader: r.headers['x-contrats-timestamp'] as string,
    })).toEqual({ ok: true });
  });

  test('une transition qui n’est pas dans la table ne publie rien', async () => {
    await createSub(['contract.terminated', 'contract.signed', 'contract.activated']);
    const before = await asAdmin1((tx) => tx.webhookEvent.count({ where: { tenantId: t1.tenantId } }));
    await http_().post(`/v1/contracts/${t1.customerA.contractId}/submit`).set('x-lsi-session', 'wh-am-1');
    const after = await asAdmin1((tx) => tx.webhookEvent.count({ where: { tenantId: t1.tenantId } }));
    expect(after).toBe(before);
  });
});
