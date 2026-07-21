import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { systemScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedNotif(recipientUserId: string, customerId: string, subject: string, readAt: Date | null = null) {
  const id = uuidv7(); const now = new Date();
  await withScope(systemScope(fx.tenantId, customerId), (tx) => tx.notification.create({ data: {
    id, tenantId: fx.tenantId, customerId, recipientUserId, type: 'CLIENT_COMMENT',
    subject, body: 'corps', status: readAt ? 'READ' : 'QUEUED', readAt, createdAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) }, 3600);
});
const as = (s: string) => (m: 'get'|'post'|'patch', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);
const asA = as('sess-am-a'); const asB = as('sess-am-b');

describe('centre de notifications', () => {
  test('chacun ne voit que sa boîte, avec unreadCount', async () => {
    await seedNotif(fx.amUserId, fx.customerA.id, 'Pour A #1');
    await seedNotif(fx.amUserId, fx.customerA.id, 'Pour A #2', new Date());
    await seedNotif(fx.amBUserId, fx.customerB.id, 'Pour B #1');
    const a = await asA('get', '/v1/notifications').expect(200);
    const subjectsA = a.body.items.map((i: any) => i.subject);
    expect(subjectsA).toContain('Pour A #1');
    expect(subjectsA).toContain('Pour A #2');
    expect(subjectsA).not.toContain('Pour B #1');
    expect(a.body.unreadCount).toBe(1); // seul « Pour A #1 » est non-lu
  });

  test('PATCH /:id/read marque lu et fait baisser unreadCount', async () => {
    const id = await seedNotif(fx.amUserId, fx.customerA.id, 'À lire');
    const before = (await asA('get', '/v1/notifications').expect(200)).body.unreadCount;
    await asA('patch', `/v1/notifications/${id}/read`).expect(200);
    const after = (await asA('get', '/v1/notifications').expect(200)).body.unreadCount;
    expect(after).toBe(before - 1);
  });

  test('marquer lue la notif d’un autre → 404 (jamais 403), sans effet', async () => {
    const id = await seedNotif(fx.amBUserId, fx.customerB.id, 'Boîte de B');
    await asA('patch', `/v1/notifications/${id}/read`).expect(404);
    // toujours non-lue pour B
    const b = await asB('get', '/v1/notifications').expect(200);
    expect(b.body.items.find((i: any) => i.id === id)?.readAt).toBeNull();
  });

  test('read-all ne touche que mes non-lues', async () => {
    await seedNotif(fx.amUserId, fx.customerA.id, 'reste-1');
    await seedNotif(fx.amUserId, fx.customerA.id, 'reste-2');
    const res = await asA('post', '/v1/notifications/read-all').expect(201);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    const a = await asA('get', '/v1/notifications').expect(200);
    expect(a.body.unreadCount).toBe(0);
  });
});
