import { Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import type { ReminderStatus } from '@lsi/domain';

@Injectable()
export class RemindersReadService {
  /**
   * Liste des rappels scopés : l'AM ne voit que les rappels de ses clients.
   *
   * Le filtre status est optionnel — validé en amont par ListRemindersDto
   * (@IsEnum), jamais un cast : une valeur hors énumération ne doit jamais
   * atteindre Prisma. Tous les rappels sont retournés triés par dueAt
   * croissant.
   */
  async list(scope: Scope, status?: ReminderStatus) {
    return withScope(scope, async (tx) => {
      const rows = await tx.reminder.findMany({
        where: status ? { status } : {},
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
