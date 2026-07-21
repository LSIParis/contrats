import { Injectable } from '@nestjs/common';
import { withScope, verifyAuditChain, type Scope } from '@lsi/persistence';
import type { ListAuditDto } from './dto/list-audit.dto.js';

@Injectable()
export class AuditReadService {
  async list(scope: Scope, q: ListAuditDto) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return withScope(scope, async (tx) => {
      const where: any = {};
      if (q.resourceType) where.resourceType = q.resourceType;
      if (q.resourceId) where.resourceId = q.resourceId;
      if (q.actorUserId) where.actorUserId = q.actorUserId;
      if (q.action) where.action = { contains: q.action };
      if (q.from || q.to) where.occurredAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
      const items = await tx.auditLog.findMany({
        where, orderBy: { occurredAt: 'desc' }, take: limit, skip: offset,
        select: { id: true, occurredAt: true, actorUserId: true, actorKind: true, action: true,
          resourceType: true, resourceId: true, requestId: true, hash: true, prevHash: true, after: true },
      });
      return { items };
    });
  }

  /** Vérifie la chaîne du tenant du scope (fonction SECURITY DEFINER). */
  async verify(scope: Scope) {
    const brokenAt = await verifyAuditChain(scope.tenantId);
    return { ok: brokenAt === null, brokenAt };
  }
}
