import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { RedisSessionStore } from '../../src/auth/redis-session-store.js';
import { internalScope, clientScope } from '@lsi/persistence';
import type { Session } from '../../src/auth/session.service.js';

let redis: Redis;
let store: RedisSessionStore;

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2),
    userId: 'u-1',
    tenantId: 't-1',
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope('t-1', ['c-1'], 'u-1'),
    ...over,
  };
}

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL!);
  store = new RedisSessionStore(redis);
});

afterAll(async () => {
  await redis.quit();
});

describe('RedisSessionStore', () => {
  test('une session écrite est relue à l’identique', async () => {
    const s = session();
    await store.put(s, 3600);
    const got = await store.get(s.sessionId);
    expect(got).toEqual(s);
  });

  test('une session inconnue renvoie null', async () => {
    expect(await store.get('inexistante')).toBeNull();
  });

  test('révoquer une session la supprime immédiatement (EC-17)', async () => {
    const s = session();
    await store.put(s, 3600);
    await store.revoke(s.sessionId);
    expect(await store.get(s.sessionId)).toBeNull();
  });

  test('le scope survit au round-trip (sérialisation fidèle)', async () => {
    // Le scope est ce qui porte le cloisonnement : une sérialisation qui
    // perdrait allCustomers ou customerIds serait une faille.
    const s = session({ scope: clientScope('t-1', 'c-9', 'client-user') });
    await store.put(s, 3600);
    const got = await store.get(s.sessionId);
    expect(got!.scope).toEqual({
      tenantId: 't-1',
      customerIds: ['c-9'],
      allCustomers: false,
      userId: 'client-user',
      actorKind: 'CLIENT',
    });
  });

  test('la session expire après son TTL', async () => {
    const s = session();
    await store.put(s, 1); // 1 seconde
    expect(await store.get(s.sessionId)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1200));
    expect(await store.get(s.sessionId)).toBeNull();
  });

  test('révoquer toutes les sessions d’un utilisateur (offboarding)', async () => {
    const uid = 'u-multi-' + Math.random().toString(36).slice(2);
    const a = session({ userId: uid });
    const b = session({ userId: uid });
    const other = session({ userId: 'autre' });
    await store.put(a, 3600);
    await store.put(b, 3600);
    await store.put(other, 3600);

    await store.revokeAllForUser(uid);

    expect(await store.get(a.sessionId)).toBeNull();
    expect(await store.get(b.sessionId)).toBeNull();
    // Les sessions des autres utilisateurs ne sont pas touchées.
    expect(await store.get(other.sessionId)).not.toBeNull();
  });

  test('l’index par utilisateur ne fuit pas après révocation individuelle', async () => {
    // Si on révoque une session individuellement puis toutes celles de
    // l'utilisateur, l'opération ne doit pas ressusciter la session révoquée
    // ni échouer sur une référence morte.
    const uid = 'u-idx-' + Math.random().toString(36).slice(2);
    const a = session({ userId: uid });
    const b = session({ userId: uid });
    await store.put(a, 3600);
    await store.put(b, 3600);
    await store.revoke(a.sessionId);
    await store.revokeAllForUser(uid);
    expect(await store.get(b.sessionId)).toBeNull();
  });
});
