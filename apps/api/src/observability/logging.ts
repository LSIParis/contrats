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
 *
 * IMPORTANT : pino-http enveloppe ce sérialiseur custom (`wrapRequestSerializer`)
 * et lui passe le req **déjà sérialisé** par `stdSerializers.req` (avec `url`,
 * `query`, `remoteAddress`, `remotePort`, …). On ne RE-sérialise donc PAS ici
 * (cela reperdrait `remoteAddress`/`remotePort` faute de `req.socket`) : on ne
 * fait que retirer le query-string du `url` et supprimer `query`.
 */
export function logReqSerializer(req: Record<string, unknown>): Record<string, unknown> {
  if (typeof req.url === 'string') req.url = req.url.split('?')[0];
  delete req.query;
  return req;
}
