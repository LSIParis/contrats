import { ContratsOperations, type Problem, type Transport } from './generated.js';

export * from './generated.js';

/** Erreur de l'API (RFC 9457) : `status`, `code` métier stable, `detail` lisible. */
export class ContratsApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem | null, readonly retryAfterSeconds: number | null) {
    super(problem?.detail ?? `HTTP ${status}`);
    this.name = 'ContratsApiError';
  }
  get code(): string | undefined {
    return this.problem?.code;
  }
}

export interface ContratsClientOptions {
  /** Ex. `https://contrats.lsi-maintenance.fr` (sans `/api/v1`). */
  readonly baseUrl: string;
  /** Clé `ctr_<prefix>_<secret>` — à garder côté serveur, jamais dans un navigateur. */
  readonly apiKey: string;
  /** Implémentation de fetch (défaut : globale, Node ≥ 18). */
  readonly fetch?: typeof fetch;
  /** Mise en cache des lectures par ETag (If-None-Match → 304). Défaut : true. */
  readonly etagCache?: boolean;
}

/**
 * Client de l'API publique Contrats.
 *
 *   const api = new ContratsClient({ baseUrl, apiKey: process.env.CONTRATS_API_KEY! });
 *   const c = await api.getContract(id);
 *   for await (const d of api.paginate((cursor) => api.listDeadlines({ cursor }))) { … }
 */
export class ContratsClient extends ContratsOperations {
  constructor(opts: ContratsClientOptions) {
    super(new FetchTransport(opts));
  }

  /** Parcourt toutes les pages d'une liste paginée par curseur. */
  async *paginate<T>(fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; nextCursor: string | null }>): AsyncGenerator<T> {
    let cursor: string | undefined;
    do {
      const p = await fetchPage(cursor);
      yield* p.data;
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
  }
}

class FetchTransport implements Transport {
  private readonly cache = new Map<string, { etag: string; body: unknown }>();

  constructor(private readonly opts: ContratsClientOptions) {}

  async request<T>(method: string, path: string, { query, body }: { query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cacheable = method === 'GET' && this.opts.etagCache !== false;
    const cached = cacheable ? this.cache.get(url.toString()) : undefined;
    if (cached) headers['If-None-Match'] = cached.etag;

    const res = await (this.opts.fetch ?? fetch)(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 304 && cached) return cached.body as T;
    if (!res.ok) {
      const problem = (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as Problem) : null;
      const ra = res.headers.get('retry-after');
      throw new ContratsApiError(res.status, problem, ra ? Number(ra) : null);
    }
    const data = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (cacheable && etag) this.cache.set(url.toString(), { etag, body: data });
    return data;
  }
}
