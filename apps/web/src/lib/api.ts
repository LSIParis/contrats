export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Code métier renvoyé par l'API (`DOCUSEAL_DISABLED`, `AI_BUDGET_EXCEEDED`…), s'il existe. */
    public readonly code?: string,
    /** Corps JSON complet de l'erreur (détails : variables invalides, transitions permises…). */
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Erreur HTTP → ApiError : message = `message` (liste jointe) ou `detail` du serveur. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = `Erreur ${res.status}`;
  let code: string | undefined;
  let body: unknown;
  try {
    const b = await res.json();
    body = b;
    message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    if (typeof b?.code === 'string') code = b.code;
  } catch {
    /* corps non-JSON : on garde le message par défaut */
  }
  return new ApiError(res.status, message, code, body);
}

/** Message d'erreur affichable (français) : `detail` serveur, sinon message générique. */
export function errorMessage(e: unknown, fallback = 'Erreur inattendue.'): string | undefined {
  if (!e) return undefined;
  return e instanceof ApiError ? e.message : fallback;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    // ApiError (sous-classe d'Error) : le code métier (503 DOCUSEAL_DISABLED…) reste lisible.
    const e = await toApiError(res);
    throw e.message === `Erreur ${res.status}` ? new ApiError(res.status, `API ${res.status} sur ${path}`, e.code, e.body) : e;
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  opts?: { headers?: Record<string, string> },
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts?.headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

/** POST multipart (upload de fichier). Pas de Content-Type : le navigateur
 *  pose lui-même le boundary `multipart/form-data`. */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' }, body: form });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw await toApiError(res);
}

export function login(): void {
  window.location.href = '/v1/auth/login';
}

/**
 * Erreur d'une requête `apiRequest` : message = `detail` (RFC 9457) ou
 * `message` du serveur ; `body` = corps complet (codes stables, erreurs
 * numérotées d'un import…).
 */
export class ApiRequestError extends ApiError {
  constructor(status: number, message: string, public readonly body: unknown) {
    super(status, message);
  }
}

/**
 * Requête JSON générique (tarification, administration). `form` : envoi
 * multipart, le navigateur pose lui-même le boundary. Réponse vide → null.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { form?: FormData },
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (opts?.form) payload = opts.form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, credentials: 'same-origin', headers, body: payload });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let parsed: unknown = null;
    let message = `Erreur ${res.status}`;
    try {
      parsed = await res.json();
      const b = parsed as { detail?: unknown; message?: unknown } | null;
      const m = b?.detail ?? b?.message;
      if (Array.isArray(m)) message = m.join(', ');
      else if (typeof m === 'string' && m) message = m;
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiRequestError(res.status, message, parsed);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Message affichable d'une erreur (le `detail` serveur quand il existe). */
export function errorText(e: unknown, fallback = 'Erreur inattendue.'): string | undefined {
  if (!e) return undefined;
  return e instanceof ApiError ? e.message : fallback;
}
