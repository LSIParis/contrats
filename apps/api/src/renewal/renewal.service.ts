import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import {
  applyEvent,
  BusinessRuleError,
  computeTerminationEffectiveDate,
  InvalidTransitionError,
  nextPeriodEnd,
  noticeDeadline,
  type ContractEvent,
  type ContractSnapshot,
} from '@lsi/domain';
import { assertKeyMatchesScope, DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';
import type { UploadedDocument } from '../common/http-io.js';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';
import { DeadlinesService } from '../deadlines/deadlines.service.js';

const PDF = 'application/pdf';
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Reconduction, renouvellement exprès et résiliation (lot 5, 02-cycle-de-vie §5).
 *
 * Le job quotidien reconduit (TACIT) et ouvre les décisions (EXPRESS) ; ici,
 * les décisions humaines : renouveler ou non, retirer une résiliation,
 * joindre le courrier de résiliation, prévisualiser la date d'effet.
 */
@Injectable()
export class RenewalService {
  constructor(
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly deadlines: DeadlinesService,
  ) {}

  /** Date d'effet calculée selon le préavis et la période en cours (brief §2). */
  async terminationPreview(scope: Scope, id: string, requested: Date | null, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const notice = { days: c.noticePeriodDays, months: c.noticePeriodMonths };
      const r = computeTerminationEffectiveDate({
        today: now, notice, periodEnd: c.endDate,
        renewalPeriodMonths: c.renewalMode === 'TACIT' ? c.renewalPeriodMonths : null,
        requestedDate: requested,
      });
      return {
        effectiveDate: iso(r.effectiveDate),
        deadlineMissed: r.deadlineMissed,
        noticeDeadline: c.endDate ? iso(noticeDeadline(c.endDate, notice)) : null,
        currentPeriodEnd: iso(c.endDate),
      };
    });
  }

  /** Renouvellement décidé : une nouvelle période, tracée dans contract_periods. */
  async renewPeriod(scope: Scope, id: string, months: number | undefined, userId: string, now: Date) {
    const result = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const duration = months ?? c.renewalPeriodMonths;
      if (!c.endDate || !duration) {
        throw new ConflictException({ code: 'V2-REN', detail: 'La durée de la nouvelle période est inconnue : précisez-la.' });
      }
      const newEnd = nextPeriodEnd(c.endDate, duration);
      const event: ContractEvent = { type: 'RENEW_PERIOD', newEndDate: newEnd };
      const next = apply(toContractSnapshot(c), event, now);
      const last = await tx.contractPeriod.aggregate({ where: { contractId: id }, _max: { periodNumber: true } });
      await tx.contractPeriod.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
          periodNumber: (last._max.periodNumber ?? 0) + 1,
          kind: c.renewalMode === 'TACIT' ? 'TACIT_RENEWAL' : 'EXPRESS_RENEWAL',
          startDate: new Date(c.endDate.getTime() + 86_400_000), endDate: newEnd,
          createdByUserId: userId, createdAt: now,
        },
      });
      await persistTransition(tx, id, event, next, now, userId);
      return { status: next.status, endDate: iso(newEnd) };
    });
    await this.deadlines.recomputeInScope(scope, id, now);
    return result;
  }

  /** Décision de ne pas renouveler : le contrat va à son terme puis expire. */
  closeRenewal(scope: Scope, id: string, reason: string, userId: string, now: Date) {
    return this.simple(scope, id, { type: 'CLOSE_RENEWAL', actorUserId: userId, reason }, userId, now);
  }

  /** Retrait d'une résiliation programmée : le contrat reprend son cours. */
  async withdrawTermination(scope: Scope, id: string, reason: string, userId: string, now: Date) {
    const r = await this.simple(scope, id, { type: 'WITHDRAW_TERMINATION', actorUserId: userId, reason }, userId, now);
    await this.deadlines.recomputeInScope(scope, id, now);
    return r;
  }

  /** Courrier de résiliation (PDF) rattaché au contrat ; empreinte calculée à réception. */
  async attachTerminationLetter(scope: Scope, id: string, file: UploadedDocument, userId: string, now: Date) {
    if (file.mimetype !== PDF || file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('Le courrier de résiliation doit être un PDF.');
    }
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { customerId: true, status: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (c.status !== 'TERMINATION_PENDING' && c.status !== 'TERMINATED') {
        throw new ConflictException({ code: 'RM-20', detail: 'Aucune résiliation enregistrée pour ce contrat.' });
      }
      const docId = uuidv7();
      const objectScope = { tenantId: scope.tenantId, customerId: c.customerId };
      const key = `t/${scope.tenantId}/c/${c.customerId}/contracts/${id}/termination/${docId}.pdf`;
      assertKeyMatchesScope(key, objectScope);
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      await this.storage.put(key, file.buffer, objectScope, PDF);
      await tx.storedDocument.create({
        data: {
          id: docId, tenantId: scope.tenantId, customerId: c.customerId, contractId: id,
          kind: 'TERMINATION_LETTER', origin: 'UPLOAD', objectKey: key, filename: file.originalname,
          contentType: PDF, sizeBytes: BigInt(file.size), sha256, uploadedByUserId: userId, createdAt: now,
        },
      });
      return { id: docId, sha256 };
    });
  }

  private simple(scope: Scope, id: string, event: ContractEvent, userId: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const next = apply(toContractSnapshot(c), event, now);
      await persistTransition(tx, id, event, next, now, userId);
      return { status: next.status };
    });
  }
}

/** Erreurs du domaine → 409 lisibles (même forme que ContractsService). */
function apply(s: ContractSnapshot, e: ContractEvent, now: Date): ContractSnapshot {
  try {
    return applyEvent(s, e, now);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      throw new ConflictException({ code: err.code, detail: err.message, currentStatus: err.currentStatus, allowedTransitions: err.allowedTransitions });
    }
    if (err instanceof BusinessRuleError) throw new ConflictException({ code: err.code, detail: err.message, rule: err.rule });
    throw err;
  }
}
