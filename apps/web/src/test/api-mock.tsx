import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Double de `fetch` par routes (écrans de tarification et d'administration).
 * Chaque appel est enregistré (méthode, URL, corps JSON ou FormData).
 * Une route renvoie un objet (200 JSON) ou une `Response` ; aucune route → 404.
 */
export type Call = { method: string; url: string; body: unknown };
export type Handler = (body: unknown, url: string) => unknown;
export type Route = [method: string, match: string | RegExp, handler: Handler];

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const problem = (status: number, detail: string, extra: Record<string, unknown> = {}) =>
  json({ status, title: 'ERR', detail, message: detail, ...extra }, status);

export function mockApi(routes: Route[], me: Record<string, unknown> = { userId: 'u-admin', fullName: 'Admin', roles: ['MSP_ADMIN'] }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body instanceof FormData) body = init.body;
    else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, url, body });
    if (url.includes('/v1/auth/me')) return json(me);
    for (const [m, match, handler] of routes) {
      if (m !== method) continue;
      const ok = typeof match === 'string' ? url === match : match.test(url);
      if (!ok) continue;
      const r = handler(body, url);
      return r instanceof Response ? r : json(r);
    }
    if (url.includes('/v1/notifications')) return json({ items: [], unreadCount: 0 });
    return new Response('', { status: 404 });
  }));
  return calls;
}

export function renderWithClient(ui: ReactNode, initialEntries: string[] = ['/']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
