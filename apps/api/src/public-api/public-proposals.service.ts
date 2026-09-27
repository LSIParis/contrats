import { Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { withScope, type Scope } from '@lsi/persistence';
import { decodeCursor, page } from './cursor.js';
import type { ProposalsQuery } from './schemas.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const c = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

const INCLUDE = {
  customer: { select: { id: true, name: true, externalRef: true, siren: true } },
  template: { select: { slug: true, name: true } },
  versions: { select: { versionNumber: true, id: true }, orderBy: { versionNumber: 'desc' as const }, take: 1 },
} as const;

/**
 * Propositions dans l'API publique (lot 9.8, brief §12.9). Aucune donnée
 * personnelle (destinataires, suivi de lecture, commentaires) : statut,
 * montants, dates, lien vers le contrat généré.
 */
@Injectable()
export class PublicProposalsService {
  async list(scope: Scope, q: z.infer<typeof ProposalsQuery>, clientRef?: string) {
    const after = decodeCursor(q.cursor, ['id']);
    return withScope(scope, async (tx) => {
      let customerId: string | undefined;
      if (clientRef !== undefined) {
        const customer = await tx.customer.findFirst({
          where: UUID_RE.test(clientRef) ? { id: clientRef } : /^\d{9}$/.test(clientRef) ? { siren: clientRef } : { externalRef: clientRef },
          select: { id: true },
        });
        if (!customer) throw new NotFoundException({ code: 'CLIENT_NOT_FOUND', detail: 'Client introuvable (identifiant, SIREN ou référence externe).' });
        customerId = customer.id;
      }
      const statuses = q.status?.split(',');
      const rows = await tx.proposal.findMany({
        where: {
          ...(customerId ? { customerId } : {}),
          ...(statuses ? { status: { in: statuses as never } } : {}),
          ...(q.updatedSince ? { updatedAt: { gte: new Date(q.updatedSince) } } : {}),
          ...(after ? { id: { gt: after.id } } : {}),
        },
        include: INCLUDE,
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      });
      const p = page(rows, q.limit, (r) => ({ id: r.id }));
      return { data: p.data.map(toProposal), nextCursor: p.nextCursor };
    });
  }

  async get(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id }, include: INCLUDE });
      if (!p) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', detail: 'Proposition introuvable.' });
      return toProposal(p);
    });
  }

  /**
   * Tarif d'une proposition : la configuration FIGÉE à l'acceptation si elle
   * existe (celle qui devient le barème du contrat), sinon le tableau proposé
   * dans la version courante avec les totaux de la configuration par défaut.
   */
  async pricing(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({ where: { id } });
      if (!p) throw new NotFoundException({ code: 'PROPOSAL_NOT_FOUND', detail: 'Proposition introuvable.' });
      const snap = p.acceptedSnapshotId ? await tx.pricingSnapshot.findUnique({ where: { id: p.acceptedSnapshotId } }) : null;
      const version = p.currentVersionId ? await tx.proposalVersion.findUnique({ where: { id: p.currentVersionId } }) : null;
      if (snap) {
        const v = await tx.proposalVersion.findUnique({ where: { id: snap.versionId }, select: { versionNumber: true } });
        return {
          proposalId: p.id, source: 'ACCEPTED' as const, versionNumber: v?.versionNumber ?? null,
          oneTimeCents: snap.oneTimeCents.toString(), monthlyCents: snap.monthlyCents.toString(),
          commitmentTotalCents: snap.commitmentTotalCents.toString(), commitmentMonths: snap.commitmentMonths,
          definition: snap.definition, selection: snap.selection, sha256: snap.sha256, frozenAt: snap.createdAt.toISOString(),
        };
      }
      return {
        proposalId: p.id, source: 'PROPOSED' as const, versionNumber: version?.versionNumber ?? null,
        oneTimeCents: c(p.oneTimeCents), monthlyCents: c(p.monthlyCents),
        commitmentTotalCents: c(p.commitmentTotalCents), commitmentMonths: p.commitmentMonths,
        definition: version?.pricingDefinition ?? null, selection: null, sha256: null, frozenAt: null,
      };
    });
  }
}

type Row = {
  id: string; number: string; title: string; status: string; acceptanceMode: string; contractId: string | null;
  oneTimeCents: bigint | null; monthlyCents: bigint | null; commitmentTotalCents: bigint | null; commitmentMonths: number | null;
  expiresAt: Date | null; sentAt: Date | null; acceptedAt: Date | null; signedAt: Date | null; convertedAt: Date | null;
  declinedAt: Date | null; expiredAt: Date | null; createdAt: Date; updatedAt: Date;
  customer: { id: string; name: string; externalRef: string | null; siren: string | null };
  template: { slug: string; name: string } | null;
  versions: { versionNumber: number }[];
};

function toProposal(p: Row) {
  return {
    id: p.id, number: p.number, title: p.title, status: p.status, acceptanceMode: p.acceptanceMode,
    customer: p.customer,
    template: p.template,
    versionNumber: p.versions[0]?.versionNumber ?? null,
    oneTimeCents: c(p.oneTimeCents), monthlyCents: c(p.monthlyCents),
    commitmentTotalCents: c(p.commitmentTotalCents), commitmentMonths: p.commitmentMonths,
    contractId: p.contractId,
    expiresAt: t(p.expiresAt), sentAt: t(p.sentAt), acceptedAt: t(p.acceptedAt), signedAt: t(p.signedAt),
    convertedAt: t(p.convertedAt), declinedAt: t(p.declinedAt), expiredAt: t(p.expiredAt),
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}
