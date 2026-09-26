import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { withScope, internalScope, adminScope, clientScope, systemScope } from '../../src/index.js';
import { setTransitionContext } from '../../src/transition.js';
import { uuidv7 } from '../../src/uuid.js';

/**
 * Garanties de la migration 17 (socle v2) — testées EN BASE, sous le rôle
 * applicatif lsi_app, jamais sous le propriétaire.
 */
let owner: PrismaClient;
let fx: Fixture;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
});

const sha = (c: string) => c.repeat(64);

async function insertDocument(customerId: string, contractId: string | null) {
  const id = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.storedDocument.create({
      data: {
        id, tenantId: fx.tenantId, customerId, contractId,
        kind: 'LEGACY_SCAN', origin: 'UPLOAD',
        objectKey: `t/${fx.tenantId}/c/${customerId}/documents/${id}.pdf`,
        filename: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 1234n,
        sha256: sha('a'), uploadedByUserId: fx.adminUserId, createdAt: new Date(),
      },
    }),
  );
  return id;
}

describe('lifecycle_events : toute transition est tracée par le trigger', () => {
  test('UPDATE du statut → une ligne (from, to, événement, motif, acteur) + une entrée d’audit chaînée', async () => {
    const scope = internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId);
    await withScope(scope, async (tx) => {
      await setTransitionContext(tx, { event: 'SUBMIT_FOR_REVIEW', reason: 'prêt pour relecture' });
      await tx.contract.update({ where: { id: fx.customerA.contractId }, data: { status: 'IN_REVIEW' } });
    });

    const events = await withScope(scope, (tx) =>
      tx.lifecycleEvent.findMany({ where: { contractId: fx.customerA.contractId }, orderBy: { seq: 'asc' } }),
    );
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      fromStatus: 'DRAFT', toStatus: 'IN_REVIEW', event: 'SUBMIT_FOR_REVIEW',
      reason: 'prêt pour relecture', actorUserId: fx.amUserId, actorKind: 'INTERNAL',
    });

    const audit = await owner.$queryRawUnsafe<{ action: string; after: { from: string; to: string } }[]>(
      `SELECT action, after FROM audit_logs WHERE resource_id = '${fx.customerA.contractId}' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit[0]).toMatchObject({ action: 'contract.transition', after: { from: 'DRAFT', to: 'IN_REVIEW' } });
  });

  test('un UPDATE qui ne change pas le statut n’ajoute rien', async () => {
    const scope = adminScope(fx.tenantId, fx.adminUserId);
    const count = () => withScope(scope, (tx) => tx.lifecycleEvent.count({ where: { contractId: fx.customerB.contractId } }));
    const before = await count();
    await withScope(scope, (tx) => tx.contract.update({ where: { id: fx.customerB.contractId }, data: { title: 'Renommé' } }));
    expect(await count()).toBe(before);
  });

  test('le contexte de transition ne survit pas à la transaction', async () => {
    const scope = adminScope(fx.tenantId, fx.adminUserId);
    await withScope(scope, (tx) => setTransitionContext(tx, { event: 'FUITE', reason: 'ne doit pas persister' }));
    await withScope(scope, (tx) => tx.contract.update({ where: { id: fx.customerB.contractId }, data: { status: 'CANCELLED' } }));
    const last = await withScope(scope, (tx) =>
      tx.lifecycleEvent.findFirst({ where: { contractId: fx.customerB.contractId }, orderBy: { seq: 'desc' } }),
    );
    expect(last).toMatchObject({ toStatus: 'CANCELLED', event: null, reason: null });
  });

  test('un traitement système est tracé SYSTEM, sans utilisateur', async () => {
    const id = uuidv7();
    await owner.$executeRawUnsafe(`
      INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category,
        currency, billing_frequency, owner_user_id, created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES ('${id}', '${fx.tenantId}', '${fx.customerA.id}', 'SYS-${id.slice(-12)}', 'Sys', 'MAIN', 'SIGNED',
        'MAINTENANCE', 'EUR', 'MONTHLY', '${fx.amUserId}', now(), now(), '${fx.amUserId}', '${fx.amUserId}')`);
    await withScope(systemScope(fx.tenantId, fx.customerA.id), (tx) =>
      tx.contract.update({ where: { id }, data: { status: 'ACTIVE' } }),
    );
    const last = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.lifecycleEvent.findFirst({ where: { contractId: id }, orderBy: { seq: 'desc' } }),
    );
    expect(last).toMatchObject({ fromStatus: 'SIGNED', toStatus: 'ACTIVE', actorKind: 'SYSTEM', actorUserId: null });
  });

  test('append-only : lsi_app ne peut ni insérer à la main, ni modifier, ni supprimer', async () => {
    const scope = adminScope(fx.tenantId, fx.adminUserId);
    await expect(
      withScope(scope, (tx) =>
        tx.lifecycleEvent.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
            toStatus: 'ACTIVE', actorKind: 'INTERNAL', occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withScope(scope, (tx) => tx.lifecycleEvent.updateMany({ data: { reason: 'réécrit' } })),
    ).rejects.toThrow(/permission denied/i);
    await expect(withScope(scope, (tx) => tx.lifecycleEvent.deleteMany({}))).rejects.toThrow(/permission denied/i);
  });

  test('isolation : l’AM du client A ne voit aucune transition du client B', async () => {
    const rows = await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), (tx) =>
      tx.lifecycleEvent.findMany({ where: { customerId: fx.customerB.id } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('stored_documents : écriture unique et cloisonnement', () => {
  test('un document ne peut être ni modifié ni supprimé par l’application', async () => {
    const id = await insertDocument(fx.customerA.id, fx.customerA.contractId);
    const scope = adminScope(fx.tenantId, fx.adminUserId);
    await expect(
      withScope(scope, (tx) => tx.storedDocument.update({ where: { id }, data: { sha256: sha('b') } })),
    ).rejects.toThrow(/permission denied/i);
    await expect(withScope(scope, (tx) => tx.storedDocument.delete({ where: { id } }))).rejects.toThrow(/permission denied/i);
  });

  test('empreinte invalide refusée en base (CHECK)', async () => {
    const id = uuidv7();
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.storedDocument.create({
          data: {
            id, tenantId: fx.tenantId, customerId: fx.customerA.id, kind: 'ATTACHMENT', origin: 'UPLOAD',
            objectKey: `t/${fx.tenantId}/c/${fx.customerA.id}/x/${id}`, filename: 'x', contentType: 'text/plain',
            sizeBytes: 1n, sha256: 'Z'.repeat(64), createdAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  test('isolation : le client A ne lit pas les documents du client B', async () => {
    const idB = await insertDocument(fx.customerB.id, fx.customerB.contractId);
    const seen = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.storedDocument.findUnique({ where: { id: idB } }),
    );
    expect(seen).toBeNull();
  });

  test('cohérence : un document du client A ne peut pas pointer le contrat de B (FK composite)', async () => {
    await expect(insertDocument(fx.customerA.id, fx.customerB.contractId)).rejects.toThrow(/foreign key/i);
  });
});

describe('feature flags : désactivés par défaut, écriture interne uniquement', () => {
  test('un client lit les drapeaux de son tenant mais ne peut pas les écrire', async () => {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.tenantFeatureFlag.create({
        data: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled', enabled: true, updatedAt: new Date(), updatedByUserId: fx.adminUserId },
      }),
    );
    const client = clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId);
    const flags = await withScope(client, (tx) => tx.tenantFeatureFlag.findMany());
    expect(flags.map((f) => f.key)).toContain('contrats.docuseal.enabled');
    await expect(
      withScope(client, (tx) =>
        tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.ai.enabled', enabled: true, updatedAt: new Date() } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test('isolation inter-tenant : les drapeaux d’un autre tenant sont invisibles et inécrivables', async () => {
    const other = uuidv7();
    await owner.$executeRawUnsafe(`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
      VALUES ('${other}', 'Autre MSP', 'autre-${other.slice(-12)}', 'ACTIVE', now(), now())`);
    await owner.$executeRawUnsafe(`INSERT INTO tenant_feature_flags (tenant_id, key, enabled, updated_at)
      VALUES ('${other}', 'contrats.api.enabled', true, now())`);
    const mine = adminScope(fx.tenantId, fx.adminUserId);
    const seen = await withScope(mine, (tx) => tx.tenantFeatureFlag.findMany({ where: { tenantId: other } }));
    expect(seen).toEqual([]);
    await expect(
      withScope(mine, (tx) =>
        tx.tenantFeatureFlag.create({ data: { tenantId: other, key: 'contrats.ai.enabled', enabled: true, updatedAt: new Date() } }),
      ),
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  test('les paramètres de tenant sont invisibles d’un client', async () => {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.tenantSetting.create({ data: { tenantId: fx.tenantId, key: 'ai.provider', value: 'perplexity', updatedAt: new Date() } }),
    );
    const rows = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.tenantSetting.findMany(),
    );
    expect(rows).toEqual([]);
  });
});

describe('portée des nouveaux rôles', () => {
  test('INTERNAL_SIGNATORY résout un scope tous-clients, READER un portefeuille', async () => {
    const { resolveUserScope } = await import('../../src/scope-resolution.js');
    const signer = uuidv7();
    const reader = uuidv7();
    for (const [u, code] of [[signer, 'INTERNAL_SIGNATORY'], [reader, 'READER']] as const) {
      await owner.$executeRawUnsafe(`INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
        VALUES ('${u}', '${fx.tenantId}', 'INTERNAL', NULL, '${code.toLowerCase()}-${u.slice(-12)}@lsi.fr', '${code}', 'ACTIVE', now(), now())`);
      const roleId = uuidv7();
      await owner.$executeRawUnsafe(`INSERT INTO roles (id, tenant_id, code, label) VALUES ('${roleId}', '${fx.tenantId}', '${code}', '${code}')
        ON CONFLICT (tenant_id, code) DO NOTHING`);
      await owner.$executeRawUnsafe(`INSERT INTO user_roles (tenant_id, user_id, role_id)
        SELECT '${fx.tenantId}', '${u}', id FROM roles WHERE tenant_id='${fx.tenantId}' AND code='${code}'`);
    }
    await owner.$executeRawUnsafe(`INSERT INTO customer_access (tenant_id, user_id, customer_id, granted_by_user_id, granted_at)
      VALUES ('${fx.tenantId}', '${reader}', '${fx.customerA.id}', '${fx.adminUserId}', now())`);

    const s = await resolveUserScope(fx.tenantId, signer);
    expect(s?.scope.allCustomers).toBe(true);
    const r = await resolveUserScope(fx.tenantId, reader);
    expect(r?.scope.allCustomers).toBe(false);
    expect(r?.scope.customerIds).toEqual([fx.customerA.id]);
  });
});
