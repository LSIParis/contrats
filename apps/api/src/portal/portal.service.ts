import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import type { ContractStatus } from '@lsi/domain';

const SIGN_PENDING = ['SENT', 'VIEWED'];
function docusealSignBase(): string {
  return process.env.DOCUSEAL_SIGN_URL ?? (process.env.DOCUSEAL_URL ?? 'http://docuseal:3000/api').replace(/\/api\/?$/, '');
}

// Allow-list (deny-by-default) : un nouveau ContractStatus est masqué tant qu'il
// n'est pas ajouté ici explicitement — inverse d'une deny-list qui l'exposerait
// silencieusement par défaut. Complément exact des 4 états internes
// (DRAFT, IN_REVIEW, CHANGES_REQUESTED, APPROVED) dans l'enum ContractStatus.
const CLIENT_VISIBLE_STATUSES: ContractStatus[] = [
  'PENDING_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'ACTIVE',
  'EXPIRED', 'RENEWED', 'TERMINATED', 'CANCELLED', 'DECLINED',
];

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
      where: { status: { in: CLIENT_VISIBLE_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: CLIENT_SAFE_SELECT,
    }));
    return { items: rows.map((c) => this.base(c)) };
  }

  async findOne(scope: Scope, id: string) {
    const email = await this.emailOf(scope, scope.userId);
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: CLIENT_SAFE_SELECT });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable'); // RLS 404 hors scope ; 404 si non partagé
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id }, orderBy: { signingOrder: 'asc' },
        select: { party: true, fullName: true, status: true, signedAt: true },
      });
      const mine = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email }, select: { status: true } })
        : null;
      const mySignature = mine ? { status: mine.status } : null;
      return { ...this.base(c), signers, mySignature };
    });
  }

  async signRedirectUrl(scope: Scope, id: string): Promise<string> {
    const email = await this.emailOf(scope, scope.userId);
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable'); // RLS → 404 hors scope ; 404 si statut interne
      const signer = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email }, select: { status: true, providerSubmitterSlug: true } })
        : null;
      if (!signer) throw new NotFoundException('Vous n’êtes pas signataire de ce contrat.');
      if (!SIGN_PENDING.includes(signer.status) || !signer.providerSubmitterSlug) {
        throw new ConflictException({ code: 'NO_PENDING_SIGNATURE', detail: 'Aucune signature en attente pour vous sur ce contrat.' });
      }
      return `${docusealSignBase()}/s/${signer.providerSubmitterSlug}`;
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
