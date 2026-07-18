import { Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

@Injectable()
export class RemindersReadService {
  /**
   * Liste des rappels scopés : l'AM ne voit que les rappels de ses clients.
   *
   * Le filtre status est optionnel. Tous les rappels sont retournés triés
   * par dueAt croissant.
   */
  async list(scope: Scope, status?: string) {
    return withScope(scope, async (tx) => {
      const rows = await tx.reminder.findMany({
        where: status ? { status: status as never } : {},
        orderBy: { dueAt: 'asc' },
        include: { contract: { select: { reference: true } } },
      });
      const items = rows.map((r) => ({
        id: r.id, contractId: r.contractId, contractReference: r.contract.reference,
        kind: r.kind, offsetDays: r.offsetDays, dueAt: r.dueAt, status: r.status, late: r.late,
      }));
      return { items, total: items.length };
    });
  }
}
