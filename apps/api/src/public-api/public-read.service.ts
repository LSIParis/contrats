import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { withScope, type Scope } from '@lsi/persistence';
import { noticeDeadline } from '@lsi/domain';
import { PricingService } from '../pricing/pricing.service.js';
import { decodeCursor, page } from './cursor.js';
import type { ClientContractsQuery, DeadlinesQuery } from './schemas.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const isoTime = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

const CONTRACT_INCLUDE = {
  customer: { select: { id: true, name: true, externalRef: true, siren: true } },
  signatureRequests: { select: { mode: true }, orderBy: { createdAt: 'desc' as const }, take: 1 },
} as const;

/**
 * Lectures de l'API publique. Le scope est celui du client d'API (tout le
 * tenant, lecture) : la RLS reste la barrière — un identifiant d'un autre
 * tenant donne 404, exactement comme une ressource inexistante.
 */
@Injectable()
export class PublicReadService {
  constructor(private readonly pricing: PricingService) {}

  async clientContracts(scope: Scope, clientRef: string, q: z.infer<typeof ClientContractsQuery>) {
    const after = decodeCursor(q.cursor, ['id']);
    return withScope(scope, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: UUID_RE.test(clientRef) ? { id: clientRef } : /^\d{9}$/.test(clientRef) ? { siren: clientRef } : { externalRef: clientRef },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException({ code: 'CLIENT_NOT_FOUND', detail: 'Client introuvable (identifiant, SIREN ou référence externe).' });
      const statuses = q.status?.split(',');
      const rows = await tx.contract.findMany({
        where: {
          customerId: customer.id,
          ...(statuses ? { status: { in: statuses as never } } : {}),
          ...(q.type ? { type: q.type } : {}),
          ...(after ? { id: { gt: after.id } } : {}),
        },
        include: CONTRACT_INCLUDE,
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      });
      const p = page(rows, q.limit, (r) => ({ id: r.id }));
      return { data: p.data.map(toContract), nextCursor: p.nextCursor };
    });
  }

  async contract(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, include: CONTRACT_INCLUDE });
      if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', detail: 'Contrat introuvable.' });
      return toContract(c);
    });
  }

  async dates(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id } });
      if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', detail: 'Contrat introuvable.' });
      const notice = { days: c.noticePeriodDays, months: c.noticePeriodMonths };
      const hasNotice = Boolean(c.noticePeriodDays || c.noticePeriodMonths);
      const ended = ['TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'RENEWED'].includes(c.status);
      const renews = !ended && c.renewalMode !== 'NONE' && c.endDate && c.status !== 'TERMINATION_PENDING';
      return {
        contractId: c.id,
        effectiveDate: iso(c.startDate),
        currentPeriodEnd: iso(c.endDate),
        noticeDeadline: c.endDate && hasNotice && !ended ? iso(noticeDeadline(c.endDate, notice)) : null,
        nextPriceRevision: ended ? null : iso(await this.pricing.nextRevisionDate(tx as never, c.id, now)),
        nextRenewal: renews ? iso(new Date(c.endDate!.getTime() + DAY)) : null,
        renewalMode: c.renewalMode,
        terminationEffectiveDate: iso(c.terminationEffectiveDate),
      };
    });
  }

  async deadlines(scope: Scope, q: z.infer<typeof DeadlinesQuery>, now: Date) {
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(from.getTime() + 90 * DAY);
    if (to < from || to.getTime() - from.getTime() > 366 * DAY) {
      throw new BadRequestException({ code: 'INVALID_RANGE', detail: 'Fenêtre invalide : `to` ≥ `from`, 366 jours au plus.' });
    }
    const after = decodeCursor(q.cursor, ['dueDate', 'id']);
    const kinds = q.kind?.split(',');
    return withScope(scope, async (tx) => {
      const rows = await tx.deadline.findMany({
        where: {
          status: 'OPEN',
          dueDate: { gte: from, lte: to },
          ...(kinds ? { kind: { in: kinds as never } } : {}),
          ...(after
            ? { OR: [{ dueDate: { gt: new Date(`${after.dueDate}T00:00:00Z`) } }, { dueDate: new Date(`${after.dueDate}T00:00:00Z`), id: { gt: after.id } }] }
            : {}),
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: q.limit + 1,
      });
      const p = page(rows, q.limit, (r) => ({ dueDate: iso(r.dueDate)!, id: r.id }));
      return {
        data: p.data.map((d) => ({
          id: d.id, contractId: d.contractId, customerId: d.customerId, kind: d.kind,
          dueDate: iso(d.dueDate)!, status: d.status, details: d.details ?? null,
        })),
        nextCursor: p.nextCursor,
      };
    });
  }
}

type ContractRow = {
  id: string; reference: string; title: string; type: string; status: string; origin: string; category: string;
  parentContractId: string | null; currency: string; startDate: Date | null; endDate: Date | null; renewalMode: string;
  signedAt: Date | null; activatedAt: Date | null; updatedAt: Date;
  customer: { id: string; name: string; externalRef: string | null; siren: string | null };
  signatureRequests: { mode: string }[];
};

function toContract(c: ContractRow) {
  return {
    id: c.id, reference: c.reference, title: c.title, type: c.type, status: c.status, origin: c.origin, category: c.category,
    customer: c.customer, parentContractId: c.parentContractId, currency: c.currency,
    startDate: iso(c.startDate), endDate: iso(c.endDate), renewalMode: c.renewalMode,
    signatureMode: c.signatureRequests[0]?.mode ?? null,
    signedAt: isoTime(c.signedAt), activatedAt: isoTime(c.activatedAt), updatedAt: c.updatedAt.toISOString(),
  };
}
