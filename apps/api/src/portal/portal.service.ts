import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import type { ContractStatus } from '@lsi/domain';

const HIDDEN: ContractStatus[] = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED']; // états internes non partagés

/** Allow-list des colonnes client-safe — appliquée au niveau requête (défense en profondeur). */
const CLIENT_SAFE_SELECT = {
  id: true, reference: true, title: true, status: true, category: true,
  startDate: true, endDate: true, amountCents: true, currency: true,
  billingFrequency: true,
} as const;

@Injectable()
export class PortalService {
  private base(c: any) {
    return {
      id: c.id, reference: c.reference, title: c.title, status: c.status, category: c.category,
      startDate: c.startDate, endDate: c.endDate, amountCents: c.amountCents, currency: c.currency,
      billingFrequency: c.billingFrequency,
    };
  }

  async list(scope: Scope) {
    const rows = await withScope(scope, (tx) => tx.contract.findMany({
      where: { status: { notIn: HIDDEN } },
      orderBy: { createdAt: 'desc' },
      select: CLIENT_SAFE_SELECT,
    }));
    return { items: rows.map((c) => this.base(c)) };
  }

  async findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: CLIENT_SAFE_SELECT });
      if (!c || HIDDEN.includes(c.status)) throw new NotFoundException('Contrat introuvable'); // RLS 404 hors scope ; 404 si non partagé
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id }, orderBy: { signingOrder: 'asc' },
        select: { party: true, fullName: true, status: true, signedAt: true },
      });
      return { ...this.base(c), signers };
    });
  }

  async me(scope: Scope, email: string) {
    const customer = await withScope(scope, (tx) => tx.customer.findFirst({ select: { name: true } }));
    return { email, customerName: customer?.name ?? null };
  }

  /** Email réel de l'utilisateur, quand la session ne le porte pas. */
  async emailOf(scope: Scope, userId: string): Promise<string | null> {
    const user = await withScope(scope, (tx) => tx.user.findUnique({ where: { id: userId }, select: { email: true } }));
    return user?.email ?? null;
  }
}
