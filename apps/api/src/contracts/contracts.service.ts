import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import {
  applyEvent,
  allowedEvents,
  InvalidTransitionError,
  BusinessRuleError,
  type ContractEvent,
  type ContractSnapshot,
} from '@lsi/domain';
import type { CreateContractDto } from './dto/create-contract.dto.js';
import type { ListContractsDto } from './dto/list-contracts.dto.js';

/**
 * Service métier des contrats.
 *
 * TOUTE méthode prend un Scope en PREMIER argument. Ce n'est pas une
 * convention de style : le service ne peut pas construire un scope, il ne
 * peut que recevoir celui qu'on lui donne. Le code ne compile pas sans.
 *
 * Il ne contient AUCUNE règle de transition : celles-ci vivent dans
 * @lsi/domain, pures et testées sans base. Le service orchestre —
 * il charge, il délègue la décision, il persiste.
 */
@Injectable()
export class ContractsService {
  async create(scope: Scope, dto: CreateContractDto, now: Date) {
    return withScope(scope, async (tx) => {
      // Le customerId du DTO est un FILTRE, pas un scope. On le vérifie
      // CONTRE le scope : si le client n'est pas dans le portefeuille de la
      // session, RLS ne trouve pas la ligne et l'on répond 404 — pas 403.
      // Un 403 confirmerait l'existence du client (RM-30).
      const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new NotFoundException('Client introuvable');

      const id = uuidv7();
      const versionId = uuidv7();

      const contract = await tx.contract.create({
        data: {
          id,
          tenantId: scope.tenantId, // ← de la SESSION, jamais du DTO
          customerId: dto.customerId,
          reference: await this.nextReference(tx, scope.tenantId, now),
          title: dto.title,
          type: dto.type ?? 'MAIN',
          status: 'DRAFT',
          category: dto.category ?? 'MAINTENANCE',
          templateVersionId: dto.templateVersionId ?? null,
          currentVersionId: versionId,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          noticePeriodDays: dto.noticePeriodDays ?? null,
          amountCents: dto.amountCents !== undefined ? BigInt(dto.amountCents) : null,
          billingFrequency: dto.billingFrequency ?? 'MONTHLY',
          ownerUserId: scope.userId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: scope.userId,
          updatedByUserId: scope.userId,
        },
      });

      await tx.contractVersion.create({
        data: {
          id: versionId,
          tenantId: scope.tenantId,
          customerId: dto.customerId,
          contractId: id,
          versionNumber: 1,
          bodyHtml: '',
          variables: {},
          createdAt: now,
          createdByUserId: scope.userId,
        },
      });

      return contract;
    });
  }

  async findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        include: { customer: { select: { id: true, name: true } } },
      });
      // RLS a déjà filtré : hors scope, la ligne n'existe simplement pas
      // pour cette session. Le comportement sûr est le comportement par
      // défaut — on n'a pas à y penser (RM-30).
      if (!c) throw new NotFoundException('Contrat introuvable');
      return c;
    });
  }

  async list(scope: Scope, q: ListContractsDto) {
    return withScope(scope, async (tx) => {
      const limit = q.limit ?? 25;
      const where: Record<string, unknown> = {};

      // Filtre facultatif : il RESTREINT dans le scope. RLS garantit qu'il
      // ne peut pas l'élargir, quelle que soit la valeur envoyée.
      if (q.customerId) where.customerId = q.customerId;
      if (q.status?.length) where.status = { in: q.status };
      if (q.expiringWithinDays) {
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() + q.expiringWithinDays);
        where.endDate = { lte: limitDate };
        where.status = { in: ['ACTIVE', 'SIGNED'] };
      }
      if (q.cursor) where.id = { gt: q.cursor };

      if (q.q?.trim()) {
        where.OR = [
          { reference: { contains: q.q.trim(), mode: 'insensitive' } },
          { title: { contains: q.q.trim(), mode: 'insensitive' } },
        ];
      }

      const rows = await tx.contract.findMany({
        where,
        take: limit + 1,
        orderBy: { id: 'asc' },
        include: { customer: { select: { id: true, name: true } } },
      });

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        pagination: { nextCursor: hasMore ? data[data.length - 1]?.id : null, hasMore },
      };
    });
  }

  /**
   * Applique un événement métier.
   *
   * Le service ne DÉCIDE pas : il charge un snapshot, laisse le domaine
   * trancher, et persiste. Les gardes ne sont pas dupliquées ici — les
   * dupliquer, c'est garantir qu'elles divergeront.
   */
  async applyEvent(scope: Scope, id: string, event: ContractEvent, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        include: {
          signers: { select: { party: true } },
          attachments: { select: { id: true } },
          amendments: { select: { status: true } },
        },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');

      const approval = await tx.contractApproval.findFirst({
        where: { contractId: id, decision: 'PENDING' },
        orderBy: { submittedAt: 'desc' },
      });

      const snapshot = this.toSnapshot(c, approval?.submittedByUserId ?? null);

      let next: ContractSnapshot;
      try {
        next = applyEvent(snapshot, event, now);
      } catch (e) {
        // Le domaine ne connaît pas HTTP. La traduction en codes de réponse
        // se fait ICI, à la frontière (§14.2, §14.3).
        if (e instanceof InvalidTransitionError) {
          throw new ConflictException({
            code: e.code,
            detail: e.message,
            currentStatus: e.currentStatus,
            allowedTransitions: e.allowedTransitions,
          });
        }
        if (e instanceof BusinessRuleError) {
          throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        }
        throw e;
      }

      return tx.contract.update({
        where: { id },
        data: {
          status: next.status,
          approvedVersionId: next.approvedVersionId,
          signedAt: next.signedAt ?? null,
          activatedAt: next.activatedAt ?? null,
          terminatedAt: next.terminatedAt ?? null,
          updatedAt: now,
          updatedByUserId: scope.userId,
        },
      });
    });
  }

  async allowedActions(scope: Scope, id: string) {
    const c = await this.findOne(scope, id);
    return allowedEvents(this.toSnapshot({ ...c, signers: [], attachments: [], amendments: [] }, null));
  }

  private toSnapshot(c: any, submittedByUserId: string | null): ContractSnapshot {
    const OPEN = ['CANCELLED', 'DECLINED', 'TERMINATED', 'EXPIRED', 'RENEWED'];
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      startDate: c.startDate,
      endDate: c.endDate,
      noticePeriodDays: c.noticePeriodDays,
      currentVersionId: c.currentVersionId,
      approvedVersionId: c.approvedVersionId,
      submittedByUserId,
      hasLsiSigner: (c.signers ?? []).some((s: any) => s.party === 'LSI'),
      hasClientSigner: (c.signers ?? []).some((s: any) => s.party === 'CLIENT'),
      // Simplification MVP : la notion de pièce jointe OBLIGATOIRE dépendra
      // du modèle (ticket C-02). Aucune n'est obligatoire aujourd'hui.
      hasRequiredAttachments: true,
      openAmendmentExists: (c.amendments ?? []).some((a: any) => !OPEN.includes(a.status)),
      hasSignedSuccessor: c.successorContractId !== null,
      signedAt: c.signedAt,
      activatedAt: c.activatedAt,
      terminatedAt: c.terminatedAt,
    };
  }

  private async nextReference(tx: any, tenantId: string, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const count = await tx.contract.count({ where: { reference: { startsWith: `LSI-${year}-` } } });
    return `LSI-${year}-${String(count + 1).padStart(4, '0')}`;
  }
}
