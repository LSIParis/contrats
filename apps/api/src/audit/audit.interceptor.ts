import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { AuditService } from './audit.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = /password|secret|token/i.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

/** resourceType = 1er segment métier après /v1 (en sautant 'portal'). */
function resourceTypeOf(path: string): string {
  const seg = path.split('?')[0].split('/').filter(Boolean); // ['v1','contracts',...]
  let i = seg.indexOf('v1');
  i = i < 0 ? 0 : i + 1;
  if (seg[i] === 'portal') i += 1;
  return seg[i] ?? 'unknown';
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req: any = ctx.switchToHttp().getRequest();
    const method: string = req.method;
    const session = req.session;
    const path: string = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const skip = !MUTATING.has(method) || !session || path === '/health' || path.startsWith('/v1/auth/');
    if (skip) return next.handle();
    return next.handle().pipe(tap({
      next: () => {
        const resId = typeof req.params?.id === 'string' && UUID_RE.test(req.params.id) ? req.params.id : null;
        void this.audit.record({
          tenantId: session.tenantId,
          customerId: null,
          actorUserId: session.userId ?? null,
          actorKind: session.scope?.actorKind ?? 'INTERNAL',
          actorIp: req.ip ?? null,
          actorUserAgent: (req.headers?.['user-agent'] as string) ?? null,
          action: `${method} ${req.route?.path ?? path}`,
          resourceType: resourceTypeOf(path),
          resourceId: resId,
          after: redact(req.body),
          requestId: (req.headers?.['x-request-id'] as string) ?? null,
          occurredAt: new Date(),
        });
      },
      // Sur erreur : pas d'audit (succès uniquement).
    }));
  }
}
