import { describe, test, expect } from 'vitest';
import { ContratsApiError, ContratsClient } from '../src/index.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses.shift()!;
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

describe('client TypeScript de l’API Contrats', () => {
  test('authentifie, encode le chemin et la requête', async () => {
    const { f, calls } = fakeFetch([json({ data: [], nextCursor: null })]);
    const api = new ContratsClient({ baseUrl: 'https://contrats.example', apiKey: 'ctr_k', fetch: f });
    await api.listClientContracts('CH/42', { status: 'ACTIVE', limit: 10 });
    expect(calls[0]!.url).toBe('https://contrats.example/api/v1/clients/CH%2F42/contracts?status=ACTIVE&limit=10');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer ctr_k');
  });

  test('ETag : If-None-Match envoyé, 304 → réponse en cache', async () => {
    const body = { id: 'x' };
    const { f, calls } = fakeFetch([json(body, { headers: { etag: '"abc"' } }), new Response(null, { status: 304 })]);
    const api = new ContratsClient({ baseUrl: 'https://c.example', apiKey: 'k', fetch: f });
    await api.getContract('x');
    const again = await api.getContract('x');
    expect((calls[1]!.init.headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
    expect(again).toEqual(body);
  });

  test('erreur RFC 9457 → ContratsApiError (code, Retry-After)', async () => {
    const { f } = fakeFetch([json({ type: 't', title: 'Trop', status: 429, detail: 'Débit dépassé', instance: 'i', code: 'RATE_LIMITED' }, { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '12' } })]);
    const api = new ContratsClient({ baseUrl: 'https://c.example', apiKey: 'k', fetch: f });
    const err = await api.getContract('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContratsApiError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 12, message: 'Débit dépassé' });
  });

  test('pagination par curseur : toutes les pages', async () => {
    const { f, calls } = fakeFetch([json({ data: [1, 2], nextCursor: 'c2' }), json({ data: [3], nextCursor: null })]);
    const api = new ContratsClient({ baseUrl: 'https://c.example', apiKey: 'k', fetch: f });
    const all: unknown[] = [];
    for await (const d of api.paginate((cursor) => api.listDeadlines(cursor ? { cursor } : {}))) all.push(d);
    expect(all).toEqual([1, 2, 3]);
    expect(calls[1]!.url).toContain('cursor=c2');
  });
});
