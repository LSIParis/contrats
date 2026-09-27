import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Base des identifiants de type d'erreur (documentés dans 07-api.md §6). */
export const PROBLEM_BASE = 'https://contrats.lsi-maintenance.fr/api/problems/';

const TITLES: Record<number, string> = {
  400: 'Requête invalide',
  401: 'Authentification requise',
  403: 'Accès refusé',
  404: 'Ressource introuvable',
  409: 'Conflit',
  422: 'Requête non traitable',
  429: 'Trop de requêtes',
  500: 'Erreur interne',
  502: 'Service tiers en erreur',
  503: 'Service indisponible',
  504: 'Délai dépassé',
};

/**
 * Erreurs de l'API publique au format RFC 9457 (`application/problem+json`).
 *
 * `type` est un URI stable par code métier (`…/problems/invalid-cursor`),
 * `title` le libellé générique du statut, `detail` le message lisible,
 * `instance` l'identifiant de requête. Les champs métier utiles (`code`,
 * `errors` de validation) sont conservés en extensions. Jamais de pile.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const obj = (typeof body === 'object' && body ? body : {}) as Record<string, unknown>;
    if (status >= 500) this.log.error(exception instanceof Error ? exception.message : String(exception));

    const code = typeof obj.code === 'string' ? obj.code : codeForStatus(status);
    const detail =
      typeof obj.detail === 'string' ? obj.detail
      : typeof body === 'string' ? body
      : Array.isArray(obj.message) ? obj.message.join(' ; ')
      : typeof obj.message === 'string' && status < 500 ? obj.message
      : TITLES[status] ?? 'Erreur';

    const { code: _c, detail: _d, message: _m, statusCode: _s, error: _e, ...extensions } = obj;
    void reply
      .status(status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: `${PROBLEM_BASE}${code.toLowerCase().replace(/_/g, '-')}`,
        title: TITLES[status] ?? 'Erreur',
        status,
        detail,
        instance: `urn:request:${String(req.id)}`,
        code,
        ...(status < 500 ? extensions : {}),
      });
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    case 503: return 'UNAVAILABLE';
    default: return status >= 500 ? 'INTERNAL' : 'ERROR';
  }
}
