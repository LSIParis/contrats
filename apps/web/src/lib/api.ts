export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`API ${res.status} sur ${path}`);
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
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

/** POST multipart (upload de fichier). Pas de Content-Type : le navigateur
 *  pose lui-même le boundary `multipart/form-data`. */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' }, body: form });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
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
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
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
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? b?.detail ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
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
