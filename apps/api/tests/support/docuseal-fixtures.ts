import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { vi } from 'vitest';

/**
 * Fixtures DocuSeal (test/fixtures/docuseal/, racine du dépôt) et fetch
 * simulé. AUCUN appel réseau réel : tout `fetch` non prévu par une route
 * fait ÉCHOUER le test — un test qui parlerait à DocuSeal en douce serait
 * un test qui passe ou casse selon la météo.
 *
 * Les fixtures portent des jetons `__SUBMISSION_ID__`, `__CLIENT_SIGNER_ID__`,
 * `__TENANT_ID__`… remplacés au chargement : les identifiants réels viennent
 * de la base de test, pas du fichier.
 */

const DIR = fileURLToPath(new URL('../../../../test/fixtures/docuseal/', import.meta.url));

/** Charge le texte brut d'une fixture, jetons remplacés. */
export function fixtureText(name: string, vars: Record<string, string | number> = {}): string {
  let text = readFileSync(`${DIR}${name}`, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    // "__KEY__" en valeur JSON entière → valeur typée (un id numérique reste un nombre)…
    text = text.split(`"__${key}__"`).join(JSON.stringify(value));
    // …et __KEY__ à l'intérieur d'une chaîne (URL) → texte.
    text = text.split(`__${key}__`).join(String(value));
  }
  return text;
}

export function loadFixture<T = any>(name: string, vars: Record<string, string | number> = {}): T {
  return JSON.parse(fixtureText(name, vars)) as T;
}

/** Une réponse HTTP décrite par une fixture `{status, body}`. */
export function fixtureResponse(name: string, vars: Record<string, string | number> = {}): Response {
  const f = loadFixture<{ status: number; body: unknown }>(name, vars);
  return new Response(JSON.stringify(f.body), { status: f.status, headers: { 'content-type': 'application/json' } });
}

/** L'erreur que `fetch` lève pour une fixture `{error: {name, message}}` (délai dépassé). */
export function fixtureFetchError(name: string): Error {
  const f = loadFixture<{ error: { name: string; message: string } }>(name);
  return new DOMException(f.error.message, f.error.name);
}

export function pdfResponse(label: string): Response {
  return new Response(Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF`, 'utf8'), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Route = {
  readonly method?: string;
  readonly match: string | RegExp;
  readonly reply: () => Response | Promise<Response>;
};

/**
 * Remplace `fetch` par un routeur de fixtures. Renvoie la liste des appels
 * reçus (URL, méthode, en-têtes, corps JSON) pour les assertions.
 */
export function stubFetch(routes: readonly Route[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method, headers, body });

    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.match === 'string' ? url === r.match : r.match.test(url)),
    );
    if (!route) throw new Error(`fetch NON PRÉVU par le test : ${method} ${url}`);
    return route.reply();
  });
  return calls;
}

/** Réplique FIDÈLE de DocuSeal lib/webhook_urls/signatures.rb. */
export function docusealSignature(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `${timestamp}.${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
