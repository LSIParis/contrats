export class Unauthorized extends Error {}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`API ${res.status} sur ${path}`);
  return res.json() as Promise<T>;
}

export function login(): void {
  window.location.href = '/v1/auth/login';
}
