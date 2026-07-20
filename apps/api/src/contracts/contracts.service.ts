import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import {
  applyEvent,
  allowedEvents,
  isNoticeRespected,
  assertCanRenew,
  InvalidTransitionError,
  BusinessRuleError,
  type ContractEvent,
  type ContractSnapshot,
} from '@lsi/domain';
import {
  DOCUMENT_STORAGE,
  assertKeyMatchesScope,
  type DocumentStorage,
} from '../documents/document-storage.port.js';
import type { CreateContractDto } from './dto/create-contract.dto.js';
import type { ListContractsDto } from './dto/list-contracts.dto.js';
import type { TerminateContractDto } from './dto/terminate-contract.dto.js';
import type { Session } from '../auth/session.service.js';

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
  constructor(@Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage) {}

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

      const sigReq = await tx.signatureRequest.findFirst({
        where: { contractId: id },
        orderBy: { createdAt: 'desc' },
      });
      const signers = await tx.contractSigner.findMany({
        where: { contractId: id },
        orderBy: { signingOrder: 'asc' },
        select: { id: true, party: true, fullName: true, email: true, signingOrder: true, status: true, signedAt: true },
      });
      const approval = await tx.contractApproval.findFirst({
        where: { contractId: id },
        orderBy: { submittedAt: 'desc' },
        select: { submittedByUserId: true, decision: true, reason: true, decidedByUserId: true },
      });
      const reminders = await tx.reminder.findMany({
        where: { contractId: id },
        orderBy: { offsetDays: 'desc' },
        select: { kind: true, offsetDays: true, dueAt: true, status: true, sentAt: true, late: true },
      });
      // signature_events n'a PAS de contract_id — on relie par la demande de
      // signature (vérifié dans le schéma).
      const events = sigReq
        ? await tx.signatureEvent.findMany({
            where: { signatureRequestId: sigReq.id },
            orderBy: { occurredAt: 'asc' },
            select: { eventType: true, occurredAt: true, submitterEmail: true },
          })
        : [];

      const timeline = [
        c.createdAt && { at: c.createdAt, type: 'CREATED', label: 'Contrat créé' },
        c.signedAt && { at: c.signedAt, type: 'SIGNED', label: 'Signé' },
        c.activatedAt && { at: c.activatedAt, type: 'ACTIVATED', label: 'Activé' },
        ...events.map((e) => ({
          at: e.occurredAt, type: e.eventType,
          label: `${e.eventType}${e.submitterEmail ? ` — ${e.submitterEmail}` : ''}`,
        })),
      ]
        .filter((x): x is { at: Date; type: string; label: string } => Boolean(x))
        .sort((a, b) => a.at.getTime() - b.at.getTime());

      // Renouvellement (§6.12) : la dernière demande de renouvellement DE ce
      // contrat (côté parent) + son successeur, et le prédécesseur (côté
      // successeur), si l'un ou l'autre existe.
      const renewalRow = await tx.renewalRequest.findFirst({
        where: { contractId: id },
        orderBy: { initiatedAt: 'desc' },
      });
      let renewal = null;
      if (renewalRow) {
        const succ = renewalRow.newContractId
          ? await tx.contract.findUnique({ where: { id: renewalRow.newContractId }, select: { reference: true, status: true } })
          : null;
        renewal = { status: renewalRow.status, newContractId: renewalRow.newContractId, refusalReason: renewalRow.refusalReason, successor: succ };
      }
      const predecessor = c.predecessorContractId
        ? await tx.contract.findUnique({ where: { id: c.predecessorContractId }, select: { id: true, reference: true } })
        : null;

      return {
        contract: c,
        customer: c.customer,
        signers,
        approval,
        // Conservé pour le composant SignatureBlock du cockpit, qui lit
        // signatureRequest.signers — on ne le casse pas, on réutilise le
        // même tableau plutôt que de le dupliquer avec un select différent.
        signatureRequest: sigReq ? { status: sigReq.status, signers } : null,
        reminders,
        timeline,
        renewal,
        predecessor,
      };
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

      // Fail-closed RM-10 : un contrat legacy peut être passé en IN_REVIEW /
      // CHANGES_REQUESTED AVANT que la persistance de contract_approvals
      // n'existe — il n'a donc AUCUNE ligne PENDING. Sans ce garde-fou,
      // `approval` est null, le snapshot domaine reçoit
      // submittedByUserId = null, la garde RM-10 (soumetteur ≠ valideur) ne
      // se déclenche jamais, ET le `&& approval` ci-dessous empêche toute
      // écriture — une APPROVED silencieuse, sans séparation des tâches. On
      // refuse plutôt que d'autoriser une auto-approbation muette. Ce throw
      // précède toute mutation : la transaction withScope l'annule proprement.
      if ((event.type === 'APPROVE' || event.type === 'REQUEST_CHANGES') && !approval) {
        throw new ConflictException({
          code: 'RM-10',
          detail: 'Aucune demande de validation en cours pour ce contrat.',
        });
      }

      // Persistance des approbations (RM-10). Le domaine a déjà tranché : sur
      // APPROVE/REQUEST_CHANGES, il lève si l'acteur est le soumetteur, donc
      // on n'atteint l'update que pour un valideur distinct (le CHECK base
      // `decided_by <> submitted_by` est le filet).
      if (event.type === 'SUBMIT_FOR_REVIEW') {
        await tx.contractApproval.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
            versionId: c.currentVersionId!, // garanti par la règle domaine (RM-11)
            submittedByUserId: event.actorUserId, decision: 'PENDING', submittedAt: now,
          },
        });
      } else if (event.type === 'APPROVE' && approval) {
        await tx.contractApproval.update({
          where: { id: approval.id },
          data: { decision: 'APPROVED', decidedByUserId: event.actorUserId, decidedAt: now },
        });
      } else if (event.type === 'REQUEST_CHANGES' && approval) {
        await tx.contractApproval.update({
          where: { id: approval.id },
          data: { decision: 'CHANGES_REQUESTED', decidedByUserId: event.actorUserId, decidedAt: now, reason: event.reason },
        });
      }

      if (event.type === 'CANCEL') {
        await tx.cancellation.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
            type: 'CANCELLATION', reason: event.reason, initiatedBy: 'LSI',
            effectiveDate: now, noticeRespected: true,
            createdByUserId: event.actorUserId, createdAt: now,
          },
        });
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

  /**
   * Résiliation (RM-20) avec traçage de la Cancellation (type=TERMINATION).
   *
   * Comme `applyEvent`, le service ne décide pas : le domaine tranche
   * (préavis, dérogation admin justifiée), le service persiste.
   */
  async terminate(scope: Scope, id: string, dto: TerminateContractDto, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        include: { signers: { select: { party: true } }, attachments: { select: { id: true } }, amendments: { select: { status: true } } },
      });
      if (!c) throw new NotFoundException('Contrat introuvable'); // RLS -> 404 hors scope

      const effectiveDate = new Date(dto.effectiveDate);
      const isAdmin = session.roles.includes('MSP_ADMIN');
      const snapshot = this.toSnapshot(c, null);
      try {
        applyEvent(snapshot, { type: 'TERMINATE', actorUserId: session.userId, reason: dto.reason, effectiveDate, isAdmin, overrideReason: dto.overrideReason }, now);
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          throw new ConflictException({ code: e.code, detail: e.message, currentStatus: e.currentStatus, allowedTransitions: e.allowedTransitions });
        }
        if (e instanceof BusinessRuleError) {
          throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        }
        throw e;
      }

      const noticeRespected = isNoticeRespected(c.noticePeriodDays, effectiveDate, now);

      await tx.cancellation.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
          type: 'TERMINATION', reason: dto.reason.trim(), initiatedBy: dto.initiatedBy,
          effectiveDate, noticeRespected,
          overrideReason: noticeRespected ? null : (dto.overrideReason?.trim() ?? null),
          overrideByUserId: noticeRespected ? null : session.userId,
          createdByUserId: session.userId, createdAt: now,
        },
      });

      await tx.contract.update({
        where: { id },
        data: { status: 'TERMINATED', terminatedAt: now, updatedAt: now, updatedByUserId: session.userId },
      });

      return { status: 'TERMINATED' as const, effectiveDate: dto.effectiveDate, noticeRespected };
    });
  }

  /**
   * Renouvellement (RM-16, §6.12) : crée un contrat successeur DRAFT
   * pré-rempli à partir du parent, et une RenewalRequest PENDING qui les lie.
   *
   * Comme `assertCanAmend`/avenant, le domaine ne fait QUE la garde de
   * statut (RM-16) : l'unicité « un seul renouvellement en cours » est une
   * contrainte applicative (une ligne PENDING existante), pas une règle
   * portant sur le snapshot du contrat lui-même.
   */
  async renew(scope: Scope, id: string, session: Session, now: Date) {
    return withScope(scope, async (tx) => {
      const parent = await tx.contract.findUnique({
        where: { id },
        include: { signers: { select: { party: true } }, attachments: { select: { id: true } }, amendments: { select: { status: true } } },
      });
      if (!parent) throw new NotFoundException('Contrat introuvable'); // RLS -> 404 hors scope

      try {
        assertCanRenew(this.toSnapshot(parent, null));
      } catch (e) {
        if (e instanceof BusinessRuleError) throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        throw e;
      }

      const existing = await tx.renewalRequest.findFirst({ where: { contractId: id, status: 'PENDING' } });
      if (existing) {
        throw new ConflictException({ code: 'RENEWAL_ALREADY_IN_PROGRESS', detail: 'Un renouvellement est déjà en cours pour ce contrat.' });
      }

      const start = parent.endDate ? new Date(parent.endDate.getTime() + 86400000) : now;
      const end = parent.startDate && parent.endDate
        ? new Date(start.getTime() + (parent.endDate.getTime() - parent.startDate.getTime()))
        : null;

      const newId = uuidv7();
      const successor = await tx.contract.create({
        data: {
          id: newId, tenantId: parent.tenantId, customerId: parent.customerId,
          reference: await this.nextReference(tx, parent.tenantId, now),
          title: `${parent.title} (renouvellement)`, type: 'MAIN', status: 'DRAFT',
          category: parent.category, currency: parent.currency, billingFrequency: parent.billingFrequency,
          amountCents: parent.amountCents, noticePeriodDays: parent.noticePeriodDays,
          predecessorContractId: parent.id, startDate: start, endDate: end,
          ownerUserId: session.userId, createdAt: now, updatedAt: now, createdByUserId: session.userId, updatedByUserId: session.userId,
        },
      });
      await tx.contract.update({
        where: { id },
        data: { successorContractId: newId, updatedAt: now, updatedByUserId: session.userId },
      });
      try {
        await tx.renewalRequest.create({
          data: {
            id: uuidv7(), tenantId: parent.tenantId, customerId: parent.customerId, contractId: id,
            newContractId: newId, status: 'PENDING', initiatedByUserId: session.userId, initiatedAt: now,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') {
          // renewal_requests_one_pending (§8.3) : un seul renouvellement en
          // attente par contrat. La contrainte est en base, pas dans un `if` —
          // le `findFirst` ci-dessus est le chemin rapide, ceci est le filet
          // contre un double-submit concurrent (même course que
          // signature_requests_one_active).
          throw new ConflictException({
            code: 'RENEWAL_ALREADY_IN_PROGRESS',
            detail: 'Un renouvellement est déjà en cours pour ce contrat.',
          });
        }
        throw e;
      }
      return { id: newId, reference: successor.reference };
    });
  }

  /**
   * URL présignée (courte durée) vers la preuve PDF signée. (§10.7)
   *
   * On récupère la clé ET le scope objet (tenant + customer) depuis la
   * `signature_request`, jamais depuis le DTO/l'appelant : c'est la seule
   * source fiable pour construire l'ObjectScope attendu par le stockage.
   */
  async signedDocumentUrl(scope: Scope, id: string): Promise<{ url: string }> {
    const found = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) return null; // hors scope : RLS a déjà filtré → 404
      const sr = await tx.signatureRequest.findFirst({
        where: { contractId: id, signedPdfObjectKey: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { signedPdfObjectKey: true, tenantId: true, customerId: true },
      });
      return sr?.signedPdfObjectKey
        ? { key: sr.signedPdfObjectKey, tenantId: sr.tenantId, customerId: sr.customerId }
        : null;
    });
    if (!found) throw new NotFoundException('Aucune preuve signée disponible');

    const objScope = { tenantId: found.tenantId, customerId: found.customerId };
    assertKeyMatchesScope(found.key, objScope); // refuse une clé hors du scope
    const url = await this.storage.presignedGetUrl(found.key, objScope, 300); // TTL 5 min
    return { url };
  }

  async allowedActions(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      // On charge les VRAIS signataires : sinon la garde SUBMIT (LSI+client)
      // ne serait jamais satisfaite et « Soumettre » n'apparaîtrait jamais.
      const c = await tx.contract.findUnique({
        where: { id },
        include: { signers: { select: { party: true } } },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      return allowedEvents(this.toSnapshot({ ...c, attachments: [], amendments: [] }, null));
    });
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
