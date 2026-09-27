import { vi } from 'vitest';

/**
 * Faux `fetch` aiguillé par « MÉTHODE chemin » (chemin sans la query ; `*` en
 * fin de clé = préfixe). Chaque appel est enregistré avec son corps JSON.
 */
export type Handler = (body: unknown, url: string) => [status: number, body: unknown] | unknown;

export interface FetchCall { method: string; url: string; body: unknown }

export function routeFetch(routes: Record<string, Handler | unknown>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0]!;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    } else {
      body = init?.body;
    }
    calls.push({ method, url, body });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ') as [string, string];
      if (m !== method) return false;
      return p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p;
    });
    if (!key) return new Response(JSON.stringify({ message: `Route non simulée : ${method} ${path}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const h = routes[key];
    const out = typeof h === 'function' ? (h as Handler)(body, url) : h;
    const [status, payload] = Array.isArray(out) && out.length === 2 && typeof out[0] === 'number' ? (out as [number, unknown]) : [200, out];
    return new Response(JSON.stringify(payload ?? {}), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  return { fetchMock, calls, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split('?')[0] === path) };
}
