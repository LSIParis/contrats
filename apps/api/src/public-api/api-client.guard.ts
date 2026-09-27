import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adminScope } from '@lsi/persistence';
import type { Session } from '../auth/session.service.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import type { ApiScope } from './api-key.js';
import { ApiClientsService, type AuthenticatedClient } from './api-clients.service.js';
import { RateLimiter } from './rate-limiter.js';

const REQUIRED_SCOPES = 'lsi:apiScopes';
/** Scopes exigés par une route de l'API publique (TOUS requis). */
export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

export interface ApiRequest extends FastifyRequest {
  apiClient?: AuthenticatedClient;
  session?: Session;
}

export const API_RATE_LIMITER = Symbol('API_RATE_LIMITER');

/**
 * Authentification de l'API publique `/api/v1` (07-api.md §2).
 *
 * `Authorization: Bearer ctr_<prefix>_<secret>` → client résolu en base (clé
 * hachée), tenant actif, drapeau `contrats.api.enabled` du tenant, scopes de
 * la route, débit du client. La session posée est de service, en lecture sur
 * tout le tenant ; son identité est celle du client d'API (audit, journal).
 * Les routes de l'API publique sont @Public() pour le guard global : c'est
 * CE guard, posé sur chaque contrôleur de l'API publique, qui les protège.
 */
@Injectable()
export class ApiClientGuard implements CanActivate {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly reflector: Reflector,
    private readonly clients: ApiClientsService,
    private readonly config: TenantConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    const auth = req.headers.authorization;
    const key = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : undefined;
    if (!key) {
      void reply.header('WWW-Authenticate', 'Bearer realm="contrats"');
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', detail: 'Clé d’API absente (en-tête Authorization: Bearer).' });
    }
    const client = await this.clients.authenticate(key);
    if (!client) {
      void reply.header('WWW-Authenticate', 'Bearer realm="contrats", error="invalid_token"');
      throw new UnauthorizedException({ code: 'INVALID_API_KEY', detail: 'Clé d’API invalide ou révoquée.' });
    }
    req.apiClient = client;
    const scope = adminScope(client.tenantId, client.id);

    const rl = this.limiter.take(client.id, client.rateLimitPerMinute);
    void reply
      .header('RateLimit-Limit', String(client.rateLimitPerMinute))
      .header('RateLimit-Remaining', String(rl.remaining))
      .header('RateLimit-Reset', String(rl.resetSeconds));
    if (!rl.allowed) {
      void reply.header('Retry-After', String(rl.resetSeconds));
      throw new HttpException({ code: 'RATE_LIMITED', detail: `Débit dépassé (${client.rateLimitPerMinute} requêtes par minute).` }, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (!(await this.config.isEnabled(scope, 'contrats.api.enabled'))) {
      throw new ForbiddenException({ code: 'API_DISABLED', detail: 'L’API publique est désactivée pour cette organisation.' });
    }
    const required = this.reflector.getAllAndOverride<ApiScope[]>(REQUIRED_SCOPES, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const missing = required.filter((s) => !client.scopes.includes(s));
    if (missing.length) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', detail: `Scope manquant : ${missing.join(', ')}.`, requiredScopes: required });
    }
    req.session = { sessionId: `api:${client.id}`, userId: client.id, tenantId: client.tenantId, roles: [], scope };
    return true;
  }
}
