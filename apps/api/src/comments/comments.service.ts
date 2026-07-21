import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  /** Commentaire du contrat, visible sous scope (sinon 404). */
  private async loadComment(tx: any, contractId: string, commentId: string) {
    const cm = await tx.comment.findFirst({
      where: { id: commentId, contractId },
      select: { id: true, authorUserId: true, visibility: true, deletedAt: true },
    });
    if (!cm) throw new NotFoundException('Commentaire introuvable'); // RLS → 404 hors scope
    return cm;
  }

  /** Commentaires visibles (RLS → INTERNAL + SHARED pour un acteur interne). */
  async listInternal(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      await this.loadContract(tx, contractId);
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, body: true, visibility: true, createdAt: true, authorUserId: true,
          resolvedAt: true, editedAt: true, deletedAt: true,
          author: { select: { fullName: true } },
        },
      });
      return rows.map((r: any) => ({
        id: r.id, body: r.deletedAt ? null : r.body, visibility: r.visibility,
        authorUserId: r.authorUserId,
        resolvedAt: r.resolvedAt, editedAt: r.editedAt, deletedAt: r.deletedAt,
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

  async resolve(scope: Scope, contractId: string, commentId: string, resolverUserId: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.loadComment(tx, contractId, commentId);
      await tx.comment.update({ where: { id: commentId }, data: { resolvedAt: now, resolvedByUserId: resolverUserId, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async unresolve(scope: Scope, contractId: string, commentId: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.loadComment(tx, contractId, commentId);
      await tx.comment.update({ where: { id: commentId }, data: { resolvedAt: null, resolvedByUserId: null, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async share(scope: Scope, contractId: string, commentId: string, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.deletedAt) throw new ConflictException({ code: 'COMMENT_DELETED', detail: 'Commentaire supprimé.' });
      if (cm.visibility === 'SHARED') throw new ConflictException({ code: 'ALREADY_SHARED', detail: 'Commentaire déjà partagé.' });
      await tx.comment.update({ where: { id: commentId }, data: { visibility: 'SHARED', updatedAt: now } });
      return { ok: true as const };
    });
  }

  async edit(scope: Scope, contractId: string, commentId: string, actorUserId: string, isAdmin: boolean, body: string, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.authorUserId !== actorUserId && !isAdmin) throw new ForbiddenException('Seul l’auteur ou un administrateur peut modifier ce commentaire.');
      if (cm.deletedAt) throw new ConflictException({ code: 'COMMENT_DELETED', detail: 'Commentaire supprimé.' });
      await tx.comment.update({ where: { id: commentId }, data: { body, editedAt: now, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async softDelete(scope: Scope, contractId: string, commentId: string, actorUserId: string, isAdmin: boolean, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.authorUserId !== actorUserId && !isAdmin) throw new ForbiddenException('Seul l’auteur ou un administrateur peut supprimer ce commentaire.');
      if (!cm.deletedAt) {
        await tx.comment.update({ where: { id: commentId }, data: { deletedAt: now, deletedByUserId: actorUserId, updatedAt: now } });
      }
      return { ok: true as const };
    });
  }
}
