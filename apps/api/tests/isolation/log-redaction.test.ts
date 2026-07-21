import { describe, test, expect } from 'vitest';
import pino, { stdSerializers } from 'pino';
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
  test('ni Set-Cookie sortant ni token d’URL/query ne fuient ; chemin + IP restent', () => {
    const { logger, out } = capture();
    // Fidèle à la prod : pino-http pré-sérialise le req via stdSerializers.req
    // AVANT d'appeler notre sérialiseur custom (wrapRequestSerializer). On
    // reproduit ce pré-passage en loguant `stdSerializers.req(rawReq)`.
    const rawReq: any = {
      method: 'GET',
      url: '/v1/portal/auth/verify?token=SECRET-TOKEN',
      query: { token: 'SECRET-TOKEN' },
      headers: { cookie: '__Host-lsi_sess=SID-123', host: 'contrats.example' },
      socket: { remoteAddress: '203.0.113.7', remotePort: 44321 },
    };
    const res = {
      statusCode: 302,
      getHeader: () => undefined,
      getHeaders: () => ({ 'set-cookie': '__Host-lsi_sess=SID-123' }),
    };
    logger.info({ req: stdSerializers.req(rawReq), res }, 'requête');
    const text = out();

    expect(text).not.toContain('SECRET-TOKEN'); // token magic-link (url + query)
    expect(text).not.toContain('SID-123'); // sessionId (Set-Cookie sortant + cookie entrant)
    expect(text).toContain('/v1/portal/auth/verify'); // le chemin reste
    expect(text).toContain('203.0.113.7'); // remoteAddress préservé (traçabilité IP)
  });
});
