import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import {
  withScope, internalScope, adminScope, clientScope, tenantSystemScope,
  publishWebhookEvent, findDueWebhookDeliveries,
} from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';

/**
 * Garanties de la migration 23 (webhooks sortants) — testées EN BASE, sous
 * le rôle applicatif lsi_app : outbox transactionnelle, RLS (CLIENT exclu,
 * tenant cloisonné), bornes de la fonction de publication, append-only.
 */
let owner: PrismaClient;
let fx: Fixture;
let fx2: Fixture;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  fx2 = await seedTwoCustomers();
});

async function subscribe(f: Fixture, eventTypes: string[], active = true): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), (tx) =>
    tx.webhookSubscription.create({
      data: {
        id, tenantId: f.tenantId, url: 'https://hooks.example.com/contrats', eventTypes,
        secretCiphertext: 'iv.tag.ct', secretHint: 'abcd', active,
        disabledAt: active ? null : now, createdAt: now, updatedAt: now,
      },
    }),
  );
  return id;
}

const event = (f: Fixture, type = 'contract.signed', customerId: string | null = f.customerA.id) => ({
  eventId: uuidv7(),
  tenantId: f.tenantId,
  customerId,
  type,
  resourceId: f.customerA.contractId,
  payload: { contract: { id: f.customerA.contractId } },
  occurredAt: new Date(),
});

describe('outbox transactionnelle', () => {
  test('publication : un événement + une livraison PENDING par abonnement actif du type', async () => {
    const subSigned = await subscribe(fx, ['contract.signed', 'contract.activated']);
    await subscribe(fx, ['contract.terminated']);
    await subscribe(fx, ['contract.signed'], false); // inactif : ignoré
    const e = event(fx);
    const n = await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), (tx) => publishWebhookEvent(tx, e));
    expect(n).toBe(1);
    const deliveries = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.webhookDelivery.findMany({ where: { eventId: e.eventId } }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ subscriptionId: subSigned, status: 'PENDING', attempt: 0 });
    expect(deliveries[0]!.nextAttemptAt).not.toBeNull();
  });

  test('ROLLBACK de la transaction métier ⇒ aucun événement, aucune livraison', async () => {
    await subscribe(fx, ['contract.renewed']);
    const e = event(fx, 'contract.renewed');
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
        await publishWebhookEvent(tx, e);
        throw new Error('échec métier après publication');
      }),
    ).rejects.toThrow('échec métier');
    const [ev, del] = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      Promise.all([
        tx.webhookEvent.count({ where: { id: e.eventId } }),
        tx.webhookDelivery.count({ where: { eventId: e.eventId } }),
      ]),
    );
    expect(ev).toBe(0);
    expect(del).toBe(0);
  });

  test('une transaction CLIENT peut publier (transition portail) sans pouvoir relire', async () => {
    await subscribe(fx, ['contract.accepted_test']);
    const e = event(fx, 'contract.accepted_test');
    const scope = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const n = await withScope(scope, (tx) => publishWebhookEvent(tx, e));
    expect(n).toBe(1);
    const seen = await withScope(scope, (tx) => tx.webhookEvent.count({ where: { id: e.eventId } }));
    expect(seen).toBe(0);
  });

  test('publication refusée pour un AUTRE tenant que celui de la transaction', async () => {
    const e = event(fx2);
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e)),
    ).rejects.toThrow(/hors tenant/);
  });

  test('publication refusée pour un client hors portefeuille', async () => {
    const e = event(fx, 'contract.signed', fx.customerB.id);
    await expect(
      withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), (tx) => publishWebhookEvent(tx, e)),
    ).rejects.toThrow(/hors scope/);
  });

  test('ping ciblé : une seule livraison, quel que soit le filtre de types', async () => {
    const sub = await subscribe(fx, ['contract.terminated']);
    const e = { ...event(fx, 'ping', null), resourceId: null, onlySubscriptionId: sub };
    const n = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e));
    expect(n).toBe(1);
  });
});

describe('RLS et droits', () => {
  test('un CLIENT ne lit ni abonnements, ni événements, ni livraisons', async () => {
    await subscribe(fx, ['contract.signed']);
    const scope = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const counts = await withScope(scope, (tx) =>
      Promise.all([tx.webhookSubscription.count(), tx.webhookEvent.count(), tx.webhookDelivery.count()]),
    );
    expect(counts).toEqual([0, 0, 0]);
  });

  test('un CLIENT ne peut pas créer d’abonnement (WITH CHECK)', async () => {
    const now = new Date();
    await expect(
      withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
        tx.webhookSubscription.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, url: 'https://evil.example', eventTypes: ['contract.signed'],
            secretCiphertext: 'x', secretHint: 'x', createdAt: now, updatedAt: now,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test('le tenant 2 ne voit rien du tenant 1', async () => {
    await subscribe(fx, ['contract.signed']);
    const counts = await withScope(adminScope(fx2.tenantId, fx2.adminUserId), (tx) =>
      Promise.all([
        tx.webhookSubscription.count({ where: { tenantId: fx.tenantId } }),
        tx.webhookEvent.count({ where: { tenantId: fx.tenantId } }),
        tx.webhookDelivery.count({ where: { tenantId: fx.tenantId } }),
      ]),
    );
    expect(counts).toEqual([0, 0, 0]);
  });

  test('un commercial ne lit pas les événements d’un client hors portefeuille', async () => {
    await subscribe(fx, ['contract.expired_test']);
    const e = event(fx, 'contract.expired_test', fx.customerB.id);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e));
    const seen = await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), (tx) =>
      tx.webhookEvent.count({ where: { id: e.eventId } }),
    );
    expect(seen).toBe(0);
    const seenBySystem = await withScope(tenantSystemScope(fx.tenantId), (tx) =>
      tx.webhookEvent.count({ where: { id: e.eventId } }),
    );
    expect(seenBySystem).toBe(1);
  });

  test('outbox append-only : UPDATE et DELETE refusés à lsi_app', async () => {
    const e = event(fx, 'contract.signed');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e));
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.webhookEvent.update({ where: { id: e.eventId }, data: { type: 'contract.hacked' } }),
      ),
    ).rejects.toThrow();
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.webhookEvent.delete({ where: { id: e.eventId } })),
    ).rejects.toThrow();
  });

  test('un abonnement ne se supprime pas (DELETE révoqué)', async () => {
    const id = await subscribe(fx, ['contract.signed']);
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.webhookSubscription.delete({ where: { id } })),
    ).rejects.toThrow();
  });

  test('une livraison ne peut pas relier l’événement d’un tenant à l’abonnement d’un autre (FK composite)', async () => {
    const e = event(fx, 'contract.signed');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e));
    const foreignSub = await subscribe(fx2, ['contract.signed']);
    const now = new Date();
    await expect(
      owner.webhookDelivery.create({
        data: {
          id: uuidv7(), tenantId: fx.tenantId, eventId: e.eventId, subscriptionId: foreignSub,
          nextAttemptAt: now, createdAt: now, updatedAt: now,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('découverte des livraisons dues', () => {
  test('renvoie les identifiants dus d’abonnements actifs, et seulement eux', async () => {
    const sub = await subscribe(fx, ['contract.due_test']);
    const e = event(fx, 'contract.due_test');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => publishWebhookEvent(tx, e));
    const d = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.webhookDelivery.findFirstOrThrow({ where: { eventId: e.eventId } }),
    );
    const due = await findDueWebhookDeliveries(10_000);
    expect(due).toContainEqual({ id: d.id, tenantId: fx.tenantId });

    // Abonnement désactivé : sa livraison n'est plus proposée.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.webhookSubscription.update({ where: { id: sub }, data: { active: false, disabledAt: new Date() } }),
    );
    const after = await findDueWebhookDeliveries(10_000);
    expect(after.map((r) => r.id)).not.toContain(d.id);
  });
});
