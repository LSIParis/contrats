import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
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
      // Match insensible à la casse : l'email du user portail est lowercasé
      // à la création (users.service.ts), mais des signataires plus anciens
      // (créés avant la normalisation en écriture) peuvent porter une casse
      // mixte. Sans `mode: 'insensitive'`, la résolution échoue silencieusement.
      const mine = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email: { equals: email, mode: 'insensitive' } }, select: { status: true } })
        : null;
      const mySignature = mine ? { status: mine.status } : null;
      return { ...this.base(c), signers, mySignature };
    });
  }

  async signRedirectUrl(scope: Scope, id: string): Promise<string> {
    const email = await this.emailOf(scope, scope.userId);
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true, status: true } });
      // Message 404 unifié avec le cas « pas signataire » ci-dessous : aucun
      // oracle ne doit permettre de distinguer hors-scope / statut interne de
      // in-scope-mais-pas-signataire.
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable');
      const signer = email
        ? await tx.contractSigner.findFirst({ where: { contractId: id, party: 'CLIENT', email: { equals: email, mode: 'insensitive' } }, select: { status: true, providerSubmitterSlug: true } })
        : null;
      if (!signer) throw new NotFoundException('Contrat introuvable');
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

  /**
   * Commentaires visibles du portail (RLS → SHARED uniquement pour un CLIENT).
   *
   * Pas de `select: { author: {...} } }` : la policy `users_scope` interdit
   * à une session CLIENT de lire la ligne d'un AUTRE utilisateur (l'annuaire
   * interne LSI ne doit pas fuiter — cf. migration RLS). Un `include` Prisma
   * traversant cette frontière échoue (`author` requis, RLS renvoie 0 ligne
   * → « Field author is required to return data, got null »). On dérive donc
   * `author` sans jointure : le client ne s'authentifie que comme lui-même,
   * donc tout auteur différent de `scope.userId` est nécessairement interne.
   */
  async listComments(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true, status: true } });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable');
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, authorUserId: true, editedAt: true, deletedAt: true },
      });
      return rows.map((r) => ({
        id: r.id, body: r.deletedAt ? null : r.body,
        author: r.authorUserId === scope.userId
          ? { fullName: 'Vous', kind: 'CLIENT' as const }
          : { fullName: 'LSI', kind: 'INTERNAL' as const },
        editedAt: r.editedAt, deletedAt: r.deletedAt,
        createdAt: r.createdAt,
      }));
    });
  }

  /** Le client publie un message SHARED + notifie le propriétaire du contrat. */
  async createComment(scope: Scope, contractId: string, body: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, status: true, tenantId: true, customerId: true, ownerUserId: true, reference: true },
      });
      if (!c || !CLIENT_VISIBLE_STATUSES.includes(c.status)) throw new NotFoundException('Contrat introuvable');
      const id = uuidv7();
      await tx.comment.create({ data: {
        id, tenantId: c.tenantId, customerId: c.customerId, contractId,
        authorUserId: scope.userId, visibility: 'SHARED', body, createdAt: now, updatedAt: now,
      } });
      // Notification pour le propriétaire. Le WITH CHECK notifications_scope
      // n'exige que tenant + customer_in_scope → une session CLIENT peut créer
      // une notification destinée à l'utilisateur interne propriétaire.
      // `createMany` plutôt que `create` : le recipient (l'AM propriétaire)
      // n'est pas l'utilisateur courant, donc le SELECT implicite du
      // RETURNING d'un `create()` échouerait sur le USING de
      // notifications_scope (`recipient_user_id = app_current_user()` pour
      // un acteur non-SYSTEM) — RLS lève alors "new row violates row-level
      // security policy" alors que le WITH CHECK de l'INSERT est satisfait.
      // `createMany` n'a pas de RETURNING et n'est donc pas soumis à ce USING.
      await tx.notification.createMany({ data: [{
        id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId,
        recipientUserId: c.ownerUserId, type: 'CLIENT_COMMENT',
        subject: `Nouveau message client — ${c.reference}`,
        body, relatedContractId: contractId,
        dedupKey: `client-comment:${id}`, createdAt: now,
      }] });
      return { id };
    });
  }
}
