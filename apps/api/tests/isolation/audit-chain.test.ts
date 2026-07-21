import { describe, test, expect, beforeAll } from 'vitest';
import { withScope, adminScope, uuidv7, appendAudit, verifyAuditChain } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let fx: TwoCustomerFixture;

async function append(tenantId: string, action: string, after: unknown, actorUserId: string, occurredAt = new Date()) {
  return appendAudit({
    tenantId, customerId: null, actorUserId, actorKind: 'INTERNAL',
    actorIp: null, actorUserAgent: null, action, resourceType: 'contract',
    resourceId: null, after, requestId: null, occurredAt,
  });
}

beforeAll(async () => { fx = await seedTwoCustomers(); });

describe('chaîne d’audit', () => {
  test('deux appends chaînent et verify renvoie NULL (intègre)', async () => {
    const h1 = await append(fx.tenantId, 'A1', { x: 1 }, fx.adminUserId);
    const h2 = await append(fx.tenantId, 'A2', { x: 2 }, fx.adminUserId);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).not.toBe(h1);
    // audit_logs est protégée par RLS (§10.3) : une lecture directe de la table
    // (contrairement à un appel de fonction SECURITY DEFINER) doit passer par
    // withScope, comme tout le reste du code applicatif.
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.$queryRaw<{ prev_hash: string | null; hash: string }[]>`
        SELECT prev_hash, hash FROM audit_logs WHERE tenant_id = ${fx.tenantId}::uuid ORDER BY seq ASC`,
    );
    expect(rows.at(-1)!.prev_hash).toBe(rows.at(-2)!.hash); // chaînage
    expect(await verifyAuditChain(fx.tenantId)).toBeNull();
  });

  test('appends au même occurred_at ne forkent pas la chaîne (ordre = seq, pas id)', async () => {
    // Tous au MÊME timestamp, et antérieur à A1/A2 : sur l'ancien code
    // (chaînage ordonné par occurred_at/id), l'ordre de parcours divergeait de
    // l'ordre d'append → faux positif quasi systématique. Avec `seq` (assigné
    // sous le verrou), l'ordre de chaîne suit l'ordre d'append : intègre.
    const ts = new Date('2020-01-01T00:00:00.000Z');
    for (let i = 0; i < 6; i++) {
      await append(fx.tenantId, `SAME_TS_${i}`, {}, fx.adminUserId, ts);
    }
    expect(await verifyAuditChain(fx.tenantId)).toBeNull();
  });

  test('une entrée au hash falsifié est détectée par verify', async () => {
    await append(fx.tenantId, 'A3', { x: 3 }, fx.adminUserId);
    // insertion directe d'une entrée dont le hash ne chaîne pas (lsi_app garde INSERT)
    const badId = uuidv7();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.$executeRaw`
        INSERT INTO audit_logs (id, tenant_id, customer_id, actor_user_id, actor_kind,
          action, resource_type, occurred_at, prev_hash, hash)
        VALUES (${badId}::uuid, ${fx.tenantId}::uuid, ${null}::uuid, ${fx.adminUserId}::uuid, 'INTERNAL',
          'FORGED', 'contract', now()::timestamptz, 'deadbeef', ${'0'.repeat(64)})`,
    );
    expect(await verifyAuditChain(fx.tenantId)).toBe(badId);
  });
});
