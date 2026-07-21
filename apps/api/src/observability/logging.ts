import { stdSerializers } from 'pino';

/**
 * Chemins redactés dans les logs (§ observabilité).
 *
 * Credentials ENTRANTS (cookie de session, Authorization) ET le `Set-Cookie`
 * SORTANT : le sessionId est un bearer (quiconque le détient est authentifié),
 * le loguer en clair = fuite d'auth dans stdout → Portainer → sauvegardes.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

/**
 * Sérialiseur `req` : ne JAMAIS loguer le query-string, il porte des tokens de
 * login (magic-link `?token=`, code OIDC `?code=&state=`). On ne garde que le
 * chemin (utile au debug) et on supprime l'objet `query`.
 */
export function logReqSerializer(req: unknown): Record<string, unknown> {
  const s = stdSerializers.req(req as never) as unknown as Record<string, unknown>;
  if (typeof s.url === 'string') s.url = s.url.split('?')[0];
  delete s.query;
  return s;
}
