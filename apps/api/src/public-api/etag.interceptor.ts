import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';

/**
 * `ETag` fort sur les lectures de l'API publique, et `304 Not Modified` si
 * `If-None-Match` correspond. L'empreinte porte sur le JSON renvoyé : deux
 * réponses identiques ont le même ETag, quelle que soit l'instance.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    if (req.method !== 'GET') return next.handle();
    return next.handle().pipe(
      map((body) => {
        const json = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        const etag = `"${createHash('sha256').update(json ?? '').digest('base64url').slice(0, 32)}"`;
        void reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
        const inm = req.headers['if-none-match'];
        const tags = typeof inm === 'string' ? inm.split(',').map((t) => t.trim().replace(/^W\//, '')) : [];
        if (tags.includes(etag) || tags.includes('*')) {
          void reply.status(304);
          return undefined;
        }
        return body;
      }),
    );
  }
}
