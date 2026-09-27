export class PortalUnauthorized extends Error {}

/** Erreur HTTP du portail : message = `detail`/`message` du serveur (en français), code métier éventuel. */
export class PortalError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

async function toPortalError(res: Response): Promise<PortalError> {
  let message = `Portail ${res.status}`;
  let code: string | undefined;
  try {
    const b = await res.json();
    message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.detail ?? b?.message ?? message);
    if (typeof b?.code === 'string') code = b.code;
  } catch {
    /* corps non-JSON */
  }
  return new PortalError(res.status, message, code);
}

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) throw new PortalUnauthorized();
  if (!res.ok) throw await toPortalError(res);
  return res.json() as Promise<T>;
}

export async function portalPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toPortalError(res);
  return res.json() as Promise<T>;
}
