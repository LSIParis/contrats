import { describe, test, expect, vi } from 'vitest';
import { apiPost, ApiError, Unauthorized } from '../lib/api.js';

describe('apiPost', () => {
  test('POST réussi renvoie le JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } })));
    await expect(apiPost('/v1/customers', { name: 'X' })).resolves.toEqual({ id: 'c1' });
  });

  test('401 → Unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(apiPost('/v1/customers', {})).rejects.toBeInstanceOf(Unauthorized);
  });

  test('409 → ApiError avec le message du serveur', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ statusCode: 409, message: 'SIREN déjà utilisé' }), {
        status: 409, headers: { 'content-type': 'application/json' } })));
    await expect(apiPost('/v1/customers', {})).rejects.toMatchObject({ status: 409, message: 'SIREN déjà utilisé' });
  });
});
