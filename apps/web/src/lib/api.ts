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
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
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
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
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
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
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
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? message);
    } catch {
      /* corps non-JSON : on garde le message par défaut */
    }
    throw new ApiError(res.status, message);
  }
}

export function login(): void {
  window.location.href = '/v1/auth/login';
}
