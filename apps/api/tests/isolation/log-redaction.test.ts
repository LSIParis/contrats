import { describe, test, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { LOG_REDACT_PATHS, logReqSerializer } from '../../src/observability/logging.js';

/**
 * Prouve que la config de logs ne fait fuiter AUCUN credential :
 * - le `Set-Cookie` sortant (sessionId, un bearer) ;
 * - le token de login dans l'URL/query (magic-link, code OIDC).
 * Le chemin, lui, reste (utile au debug).
 *
 * On instancie un pino avec la MÊME redaction + le MÊME sérialiseur `req` que
 * l'app, et le sérialiseur `res` par défaut de pino-http (`stdSerializers.res`,
 * que l'app conserve car elle n'override que `req`).
 */
function capture() {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  const logger = pino(
    { level: 'info', redact: LOG_REDACT_PATHS, serializers: { req: logReqSerializer, res: pino.stdSerializers.res } },
    stream,
  );
  return { logger, out: () => buf };
}

describe('redaction des logs (observabilité)', () => {
  test('ni Set-Cookie sortant ni token d’URL/query ne fuient ; le chemin reste', () => {
    const { logger, out } = capture();
    const req = {
      method: 'GET',
      url: '/v1/portal/auth/verify?token=SECRET-TOKEN',
      query: { token: 'SECRET-TOKEN' },
      headers: { cookie: '__Host-lsi_sess=SID-123', host: 'contrats.example' },
      socket: {},
    };
    const res = {
      statusCode: 302,
      getHeader: () => undefined,
      getHeaders: () => ({ 'set-cookie': '__Host-lsi_sess=SID-123' }),
    };
    logger.info({ req, res }, 'requête');
    const text = out();

    expect(text).not.toContain('SECRET-TOKEN'); // token magic-link (url + query)
    expect(text).not.toContain('SID-123'); // sessionId (Set-Cookie sortant + cookie entrant)
    expect(text).toContain('/v1/portal/auth/verify'); // le chemin reste
  });
});
