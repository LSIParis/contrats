import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';

@Injectable()
export class CommentsService {
  /** Contrat visible sous le scope courant, sinon 404. Renvoie tenant/customer/owner. */
  private async loadContract(tx: any, contractId: string) {
    const c = await tx.contract.findUnique({
      where: { id: contractId },
      select: { id: true, tenantId: true, customerId: true, ownerUserId: true, status: true },
    });
    if (!c) throw new NotFoundException('Contrat introuvable'); // RLS → 404 hors scope
    return c;
  }

  /** Commentaires visibles (RLS → INTERNAL + SHARED pour un acteur interne). */
  async listInternal(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      await this.loadContract(tx, contractId);
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, visibility: true, createdAt: true, author: { select: { fullName: true } } },
      });
      return rows.map((r: any) => ({
        id: r.id, body: r.body, visibility: r.visibility,
        author: { fullName: r.author.fullName }, createdAt: r.createdAt,
      }));
    });
  }

  async createInternal(scope: Scope, authorUserId: string, contractId: string, body: string, visibility: 'INTERNAL' | 'SHARED', now: Date) {
    return withScope(scope, async (tx) => {
      const c = await this.loadContract(tx, contractId);
      const id = uuidv7();
      await tx.comment.create({ data: {
        id, tenantId: c.tenantId, customerId: c.customerId, contractId,
        authorUserId, visibility, body, createdAt: now, updatedAt: now,
      } });
      return { id };
    });
  }
}
