import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress, UnsafeWebhookTargetError } from './ssrf.js';

/**
 * Émission HTTP d'une livraison. Volontairement en `node:http(s)` et non en
 * `fetch` : il faut intervenir sur la RÉSOLUTION DNS de la connexion (option
 * `lookup`) pour refuser une adresse privée au moment même où la socket
 * s'ouvre — `fetch` (undici) ne l'expose pas sans dépendance supplémentaire.
 *
 *   - délai global : 10 s (connexion + réponse), au-delà : échec ;
 *   - redirections JAMAIS suivies (`node:http` ne les suit pas ; une 3xx est
 *     un échec, cf. ssrf.ts) ;
 *   - le corps de réponse est lu sur 1 Ko au plus puis abandonné : on n'en
 *     garde qu'un extrait tronqué pour le diagnostic.
 */
export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SNIPPET = 1024;

export interface SendResult {
  readonly status: number;
  readonly ms: number;
  /** Début du corps de réponse (diagnostic), tronqué. */
  readonly snippet: string;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` de connexion : résout, puis refuse si UNE des adresses est privée
 * (on ne laisse pas le système choisir « la bonne » parmi un mélange).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb): void => {
    const opts = typeof options === 'number' ? { family: options } : options ?? {};
    dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad || list.length === 0) {
          return cb(Object.assign(new UnsafeWebhookTargetError('adresse de destination privée ou réservée refusée'), { code: 'EWEBHOOKPRIVATE' }), '', 0);
        }
      }
      if (opts.all) return cb(null, list);
      const first = list[0]!;
      return cb(null, first.address, first.family);
    });
  };
}

export async function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: { allowPrivate: boolean; timeoutMs?: number },
): Promise<SendResult> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Une IP littérale ne passe PAS par `lookup` : on la juge ici.
  if (!options.allowPrivate && isIP(host) && isPrivateAddress(host)) {
    throw new UnsafeWebhookTargetError('adresse de destination privée ou réservée refusée');
  }
  if (u.protocol !== 'https:' && !(options.allowPrivate && u.protocol === 'http:')) {
    throw new UnsafeWebhookTargetError('https:// obligatoire');
  }
  const mod = u.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<SendResult>((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup: guardedLookup(options.allowPrivate) as never,
        // Pas d'agent partagé : pas de socket réutilisée d'un abonné à l'autre.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < MAX_RESPONSE_SNIPPET) {
            chunks.push(c);
            size += c.length;
          } else {
            res.destroy(); // on n'a pas besoin du reste
          }
        });
        const done = () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            ms: Date.now() - started,
            snippet: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_SNIPPET),
          });
        };
        res.on('end', done);
        res.on('close', done);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`délai de ${timeoutMs} ms dépassé`)), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
