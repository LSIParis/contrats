import { Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

/** Vignette contrat pour les listes d'échéance du cockpit (§6.1). */
interface ContractCard {
  id: string;
  reference: string;
  title: string;
  customerName: string;
  status: string;
  endDate: Date | null;
}

@Injectable()
export class DashboardService {
  /**
   * Agrégats du cockpit : compteurs par statut, échéances à 30/60/90 jours
   * (fenêtres disjointes) et rappels en attente.
   *
   * TOUT est calculé sous withScope : un AM ne voit jamais que son
   * portefeuille (§9.2/§10.5), y compris dans les compteurs agrégés.
   */
  async build(scope: Scope, now: Date) {
    return withScope(scope, async (tx) => {
      const grouped = await tx.contract.groupBy({ by: ['status'], _count: { _all: true } });
      const countsByStatus: Record<string, number> = {};
      for (const g of grouped) countsByStatus[g.status] = g._count._all;

      const in90 = new Date(now.getTime() + 90 * 86_400_000);
      const expiringRows = await tx.contract.findMany({
        where: { status: 'ACTIVE', endDate: { not: null, lte: in90 } },
        orderBy: { endDate: 'asc' },
        include: { customer: { select: { name: true } } },
      });

      // Fenêtres disjointes : j30 ≤ 30j, j60 = ]30, 60], j90 = ]60, 90].
      const buckets: { j30: ContractCard[]; j60: ContractCard[]; j90: ContractCard[] } = {
        j30: [],
        j60: [],
        j90: [],
      };
      for (const c of expiringRows) {
        const days = Math.ceil((c.endDate!.getTime() - now.getTime()) / 86_400_000);
        const card: ContractCard = {
          id: c.id,
          reference: c.reference,
          title: c.title,
          customerName: c.customer.name,
          status: c.status,
          endDate: c.endDate,
        };
        if (days <= 30) buckets.j30.push(card);
        else if (days <= 60) buckets.j60.push(card);
        else buckets.j90.push(card);
      }

      const pendingReminders = await tx.reminder.count({ where: { status: 'PENDING' } });

      return { countsByStatus, expiring: buckets, pendingReminders };
    });
  }
}
