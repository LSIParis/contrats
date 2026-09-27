/**
 * Client de l'API publique d'une proposition (`/v1/public/proposals/:token`, lot 9).
 *
 * Aucune session : le jeton du lien personnel est dans le chemin. Le code à usage
 * unique vérifié donne un jeton de session (`otpSession`), gardé en sessionStorage
 * (onglet courant seulement) et renvoyé dans l'en-tête `x-proposal-otp`.
 * Aucun montant n'est calculé ici : le serveur (moteur de tarification) calcule, la
 * page affiche.
 */

export interface Bucket { htCents: number; vatCents: number; ttcCents: number }
export interface QuotedLine {
  key: string; label: string; group: string; recurrence: string; unit: string; quantity: number;
  unitPriceCents: number; totalHtCents: number; priceStatus: string; priceFrom: boolean;
}
export interface Quote {
  choices: Record<string, string>; quantities: Record<string, number>; selectedOptions: string[]; commitmentMonths: number;
  lines: QuotedLine[]; infoLines: QuotedLine[];
  totals: { oneTime: Bucket; monthly: Bucket; quarterly: Bucket; yearly: Bucket; commitment: Bucket };
  errors: string[];
}
export interface DefChoice { key: string; label: string; editableByClient: boolean; options: { value: string; label: string; description: string | null; default: boolean }[] }
export interface DefLine {
  key: string; label: string; description: string | null; kind: 'REQUIRED' | 'OPTIONAL' | 'SETUP' | 'INFO'; unit: string;
  recurrence: string; group: string; priceFrom: boolean; pricing: unknown;
  quantity: { min: number; max: number | null; maxFrom: string | null; linkedTo: string | null; editableByClient: boolean } | null;
}
export interface Selection { choices: Record<string, string>; quantities: Record<string, number>; selectedOptions: string[] }
export interface PublicComment { id: string; parentId: string | null; sectionKey: string | null; authorKind: 'CLIENT' | 'INTERNAL'; authorName: string; body: string; createdAt: string }
export interface PublicView {
  proposal: { number: string; title: string; status: string; statusLabel: string; expiresAt: string | null; acceptanceMode: 'DOCUSEAL_SIGNATURE' | 'CLICK_ACCEPT'; sensitive: boolean; versionNumber: number };
  recipient: { fullName: string; role: 'DECISION_MAKER' | 'SIGNER' | 'READER' };
  expired: boolean;
  superseded: boolean;
  trackingNotice: string;
  otp: { required: boolean; verified: boolean };
  content: null | {
    sections: { key: string; title: string; kind: string; html: string; aiPendingReview: boolean }[];
    pricing: { definition: { vatRatePercent: number; choices: DefChoice[]; lines: DefLine[] }; selection: Selection; quote: Quote };
  };
  comments: PublicComment[];
  actions: null | { canConfigure: boolean; canComment: boolean; canDecline: boolean; canAccept: boolean; acceptRequiresOtp: boolean };
  signature: null | { status: string; embedSrc: string | null };
}
export interface AcceptResult {
  status: 'SIGNED' | 'PENDING_SIGNATURE' | 'ACCEPTED';
  signature: { signatureRequestId: string; embedSrc: string | null } | null;
  signatureError?: string;
}

export class PublicApiError extends Error {
  constructor(public readonly status: number, public readonly code: string | null, message: string) {
    super(message);
  }
}

const OTP_KEY = (token: string) => `proposition-otp:${token.slice(0, 12)}`;

export function getOtpSession(token: string): string | null {
  try {
    return sessionStorage.getItem(OTP_KEY(token));
  } catch {
    return null;
  }
}
export function setOtpSession(token: string, value: string): void {
  try {
    sessionStorage.setItem(OTP_KEY(token), value);
  } catch {
    /* stockage indisponible : l'utilisateur redemandera un code */
  }
}

export const base = (token: string) => `/v1/public/proposals/${encodeURIComponent(token)}`;

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const otp = getOtpSession(token);
  const res = await fetch(`${base(token)}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'omit',
    // Pas de Referer : le jeton est dans l'URL (l'API pose aussi Referrer-Policy: no-referrer).
    referrerPolicy: 'no-referrer',
    keepalive: init.keepalive ?? false,
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(otp ? { 'x-proposal-otp': otp } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let code: string | null = null;
    let message = `Erreur ${res.status}`;
    try {
      const b = await res.json();
      code = b?.code ?? null;
      message = Array.isArray(b?.message) ? b.message.join(', ') : (b?.detail ?? b?.message ?? message);
    } catch {
      /* corps non JSON */
    }
    throw new PublicApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const publicApi = {
  view: (t: string) => call<PublicView>(t, ''),
  events: (t: string, body: unknown, keepalive = false) => call<unknown>(t, '/events', { method: 'POST', body, keepalive }),
  select: (t: string, body: Partial<Selection>) => call<{ selection: Selection; quote: Quote }>(t, '/selection', { method: 'PUT', body }),
  comment: (t: string, body: { body: string; sectionKey?: string }) => call<PublicComment>(t, '/comments', { method: 'POST', body }),
  decline: (t: string, body: { reasonCode: string; reason?: string }) => call<{ status: string }>(t, '/decline', { method: 'POST', body }),
  requestOtp: (t: string) => call<{ sentTo: string }>(t, '/otp', { method: 'POST', body: {} }),
  verifyOtp: (t: string, code: string) => call<{ otpSession: string; expiresInSeconds: number }>(t, '/otp/verify', { method: 'POST', body: { code } }),
  accept: (t: string, body: { fullName: string; jobTitle: string; email: string; consent: true }) =>
    call<AcceptResult>(t, '/accept', { method: 'POST', body }),
};

export function formatEuros(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}
