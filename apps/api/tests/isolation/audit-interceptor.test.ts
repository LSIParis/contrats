import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, unsafeUnscopedClient, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
const db = unsafeUnscopedClient;

async function auditCount(tenantId: string, action?: string) {
  const rows = action
    ? await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM audit_logs WHERE tenant_id=${tenantId}::uuid AND action LIKE ${'%' + action + '%'}`,
      )
    : await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM audit_logs WHERE tenant_id=${tenantId}::uuid`,
      );
  return Number(rows[0].n);
}
/**
 * L'écriture d'audit est best-effort et fire-and-forget (elle se produit APRÈS
 * l'émission de la réponse, hors du cycle requête). On attend donc activement
 * que le compteur atteigne la cible plutôt que de lire immédiatement (sinon
 * flakiness : l'INSERT peut ne pas encore avoir atterri).
 */
async function waitForAuditCount(tenantId: string, target: number, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let n = await auditCount(tenantId);
  while (n < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    n = await auditCount(tenantId);
  }
  return n;
}
async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-AU-${id.slice(-8)}`,
    title: 'Audit', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  await app.get(SessionService).put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const asA = (m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', 'sess-am-a');

describe('intercepteur d’audit', () => {
  test('une mutation réussie (POST commentaire) produit une entrée d’audit', async () => {
    const c = await seedContract();
    const before = await auditCount(fx.tenantId);
    await asA('post', `/v1/contracts/${c}/comments`).send({ body: 'audité', visibility: 'INTERNAL' }).expect(201);
    const after = await waitForAuditCount(fx.tenantId, before + 1);
    expect(after).toBe(before + 1);
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.$queryRaw<{ action: string; resource_type: string; actor_user_id: string }[]>`
      SELECT action, resource_type, actor_user_id FROM audit_logs WHERE tenant_id=${fx.tenantId}::uuid ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    expect(rows[0].action).toMatch(/POST/);
    expect(rows[0].resource_type).toBe('contracts');
    expect(rows[0].actor_user_id).toBe(fx.amUserId);
  });

  test('une lecture (GET) ne produit aucune entrée', async () => {
    const c = await seedContract();
    const before = await auditCount(fx.tenantId);
    await asA('get', `/v1/contracts/${c}/comments`).expect(200);
    expect(await auditCount(fx.tenantId)).toBe(before);
  });
});
