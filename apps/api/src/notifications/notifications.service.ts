import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

const SELECT = {
  id: true, type: true, subject: true, body: true,
  relatedContractId: true, status: true, readAt: true, createdAt: true,
} as const;

@Injectable()
export class NotificationsService {
  async list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const [items, unreadCount] = await Promise.all([
        tx.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: SELECT }),
        tx.notification.count({ where: { readAt: null } }),
      ]);
      return { items, unreadCount };
    });
  }

  async markRead(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      try {
        await tx.notification.update({ where: { id }, data: { status: 'READ', readAt: now } });
      } catch (e: any) {
        if (e?.code === 'P2025') throw new NotFoundException('Notification introuvable'); // RLS → pas la mienne
        throw e;
      }
      return { ok: true as const };
    });
  }

  async markAllRead(scope: Scope, now: Date) {
    return withScope(scope, async (tx) => {
      const r = await tx.notification.updateMany({ where: { readAt: null }, data: { status: 'READ', readAt: now } });
      return { count: r.count };
    });
  }
}
