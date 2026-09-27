import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { withScope, type Scope } from '@lsi/persistence';

/**
 * Pilotage commercial (lot 9.8, brief §12.8) : pipeline, tableau de bord,
 * rapport par modèle, export CSV.
 *
 * Tout est calculé DANS le scope de l'appelant : un commercial ne voit que
 * son portefeuille, l'administrateur tout le tenant (RLS). Volumes modestes
 * (quelques milliers de propositions) : agrégation en mémoire, lisible et
 * testable, plutôt que des requêtes SQL d'agrégat difficiles à auditer.
 */

export const OPEN_STATUSES = ['DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED', 'PENDING_SIGNATURE'] as const;
const WON = new Set(['SIGNED', 'CONVERTED']);
const LOST = new Set(['DECLINED', 'EXPIRED', 'WITHDRAWN']);

/**
 * Probabilité de gain par défaut selon l'étape (V2-H67), quand le commercial
 * n'en a pas saisi une (`winProbability`).
 */
export const DEFAULT_WIN_PROBABILITY: Record<string, number> = {
  DRAFT: 10, IN_INTERNAL_REVIEW: 15, READY: 20, SENT: 30, VIEWED: 40, IN_DISCUSSION: 50,
  ACCEPTED: 80, PENDING_SIGNATURE: 90, SIGNED: 100, CONVERTED: 100, EXPIRED: 0, DECLINED: 0, WITHDRAWN: 0,
};

export const PipelineQuery = z.object({
  ownerUserId: z.uuid().optional(),
  templateId: z.uuid().optional(),
}).strict();

export const ReportQuery = z.object({
  from: z.iso.date().optional().describe('Début de période (date d’envoi) ; défaut : 12 mois glissants.'),
  to: z.iso.date().optional(),
}).strict();

const DAY = 86_400_000;
const cents = (v: bigint | null | undefined) => (v ?? 0n);
const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

type Row = {
  id: string; number: string; title: string; status: string; customerId: string; templateId: string | null; ownerUserId: string;
  winProbability: number | null; monthlyCents: bigint | null; oneTimeCents: bigint | null; commitmentTotalCents: bigint | null;
  expiresAt: Date | null; sentAt: Date | null; signedAt: Date | null; declineReasonCode: string | null; createdAt: Date;
  customer: { name: string }; owner: { fullName: string }; template: { name: string; slug: string } | null;
};

@Injectable()
export class ProposalReportingService {
  async pipeline(scope: Scope, q: z.infer<typeof PipelineQuery>) {
    const rows = (await withScope(scope, (tx) => tx.proposal.findMany({
      where: { status: { in: [...OPEN_STATUSES] }, ...(q.ownerUserId ? { ownerUserId: q.ownerUserId } : {}), ...(q.templateId ? { templateId: q.templateId } : {}) },
      include: { customer: { select: { name: true } }, owner: { select: { fullName: true } }, template: { select: { name: true, slug: true } } },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
    }))) as unknown as Row[];

    const items = rows.map((p) => {
      const amount = cents(p.commitmentTotalCents);
      const probability = p.winProbability ?? DEFAULT_WIN_PROBABILITY[p.status] ?? 0;
      return {
        id: p.id, number: p.number, title: p.title, status: p.status,
        customer: { id: p.customerId, name: p.customer.name },
        owner: { id: p.ownerUserId, name: p.owner.fullName },
        template: p.template ? { id: p.templateId, name: p.template.name, slug: p.template.slug } : null,
        monthlyCents: cents(p.monthlyCents).toString(),
        amountCents: amount.toString(),
        probability,
        weightedCents: ((amount * BigInt(probability)) / 100n).toString(),
        expiresAt: p.expiresAt?.toISOString() ?? null,
      };
    });
    const columns = OPEN_STATUSES.map((status) => {
      const col = items.filter((i) => i.status === status);
      return {
        status,
        count: col.length,
        amountCents: col.reduce((s, i) => s + BigInt(i.amountCents), 0n).toString(),
        weightedCents: col.reduce((s, i) => s + BigInt(i.weightedCents), 0n).toString(),
      };
    });
    return {
      columns,
      items,
      totals: {
        count: items.length,
        amountCents: columns.reduce((s, c) => s + BigInt(c.amountCents), 0n).toString(),
        weightedCents: columns.reduce((s, c) => s + BigInt(c.weightedCents), 0n).toString(),
      },
    };
  }

  async dashboard(scope: Scope, q: z.infer<typeof ReportQuery>, now: Date) {
    const { from, to } = period(q, now);
    return withScope(scope, async (tx) => {
      const rows = (await tx.proposal.findMany({
        where: { sentAt: { gte: from, lt: to } },
        include: { customer: { select: { name: true } }, owner: { select: { fullName: true } }, template: { select: { name: true, slug: true } } },
      })) as unknown as Row[];
      const ids = rows.map((r) => r.id);
      const [stats, snapshots] = await Promise.all([
        tx.proposalViewStat.findMany({ where: { proposalId: { in: ids } } }),
        tx.pricingSnapshot.findMany({ where: { proposalId: { in: ids } }, include: { selectionRow: { select: { selectedOptions: true } } } }),
      ]);

      const won = rows.filter((r) => WON.has(r.status));
      const decided = rows.filter((r) => WON.has(r.status) || LOST.has(r.status));
      const delays = won.filter((r) => r.sentAt && r.signedAt).map((r) => (r.signedAt!.getTime() - r.sentAt!.getTime()) / DAY);

      const conversionBy = (key: (r: Row) => string, label: (r: Row) => string) => {
        const groups = new Map<string, { label: string; sent: number; won: number; wonMonthlyCents: bigint }>();
        for (const r of rows) {
          const k = key(r);
          const g = groups.get(k) ?? { label: label(r), sent: 0, won: 0, wonMonthlyCents: 0n };
          g.sent++;
          if (WON.has(r.status)) { g.won++; g.wonMonthlyCents += cents(r.monthlyCents); }
          groups.set(k, g);
        }
        return [...groups.entries()]
          .map(([k, g]) => ({ key: k, label: g.label, sent: g.sent, won: g.won, conversionRatePercent: rate(g.won, g.sent), wonMonthlyCents: g.wonMonthlyCents.toString() }))
          .sort((a, b) => b.sent - a.sent);
      };

      const sections = new Map<string, { opens: number; durationMs: bigint }>();
      for (const s of stats) {
        if (!s.sectionKey) continue;
        const cur = sections.get(s.sectionKey) ?? { opens: 0, durationMs: 0n };
        cur.opens += s.opens;
        cur.durationMs += s.totalDurationMs;
        sections.set(s.sectionKey, cur);
      }
      const declineReasons = new Map<string, number>();
      for (const r of rows) if (r.status === 'DECLINED') declineReasons.set(r.declineReasonCode ?? 'NON_PRECISE', (declineReasons.get(r.declineReasonCode ?? 'NON_PRECISE') ?? 0) + 1);
      const options = new Map<string, number>();
      for (const s of snapshots) for (const o of optionCodes(s.selectionRow?.selectedOptions)) options.set(o, (options.get(o) ?? 0) + 1);

      return {
        period: { from: iso(from), to: iso(new Date(to.getTime() - DAY)) },
        sent: rows.length,
        won: won.length,
        lost: decided.length - won.length,
        open: rows.length - decided.length,
        conversionRatePercent: rate(won.length, rows.length),
        decidedConversionRatePercent: rate(won.length, decided.length),
        averageDaysSentToSigned: delays.length ? Math.round((delays.reduce((s, d) => s + d, 0) / delays.length) * 10) / 10 : null,
        signedRecurringMonthlyCents: won.reduce((s, r) => s + cents(r.monthlyCents), 0n).toString(),
        signedOneTimeCents: won.reduce((s, r) => s + cents(r.oneTimeCents), 0n).toString(),
        byTemplate: conversionBy((r) => r.templateId ?? 'SANS_MODELE', (r) => r.template?.name ?? 'Sans modèle'),
        byOwner: conversionBy((r) => r.ownerUserId, (r) => r.owner.fullName),
        mostReadSections: [...sections.entries()]
          .map(([sectionKey, v]) => ({ sectionKey, opens: v.opens, averageSeconds: v.opens ? Math.round(Number(v.durationMs) / v.opens / 1000) : 0 }))
          .sort((a, b) => b.opens - a.opens).slice(0, 10),
        declineReasons: [...declineReasons.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
        mostChosenOptions: [...options.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      };
    });
  }

  /** Indicateurs du tableau de bord en CSV (séparateur « ; », BOM UTF-8 pour Excel). */
  async dashboardCsv(scope: Scope, q: z.infer<typeof ReportQuery>, now: Date): Promise<string> {
    const d = await this.dashboard(scope, q, now);
    const lines: (string | number | null)[][] = [['section', 'cle', 'libelle', 'valeur', 'envoyees', 'signees', 'taux_conversion_pct', 'mrr_signe_centimes']];
    const euros = (c: string) => c;
    lines.push(['periode', 'du', '', d.period.from, '', '', '', ''], ['periode', 'au', '', d.period.to, '', '', '', '']);
    for (const [k, v] of [
      ['envoyees', d.sent], ['signees', d.won], ['perdues', d.lost], ['en_cours', d.open],
      ['taux_conversion_pct', d.conversionRatePercent], ['taux_conversion_decidees_pct', d.decidedConversionRatePercent],
      ['delai_moyen_envoi_signature_jours', d.averageDaysSentToSigned], ['mrr_signe_centimes', euros(d.signedRecurringMonthlyCents)],
      ['frais_uniques_signes_centimes', euros(d.signedOneTimeCents)],
    ] as const) lines.push(['global', k, '', v, '', '', '', '']);
    for (const t of d.byTemplate) lines.push(['modele', t.key, t.label, '', t.sent, t.won, t.conversionRatePercent, t.wonMonthlyCents]);
    for (const o of d.byOwner) lines.push(['commercial', o.key, o.label, '', o.sent, o.won, o.conversionRatePercent, o.wonMonthlyCents]);
    for (const s of d.mostReadSections) lines.push(['section_lue', s.sectionKey, '', s.opens, '', '', '', '']);
    for (const r of d.declineReasons) lines.push(['motif_refus', r.code, '', r.count, '', '', '', '']);
    for (const o of d.mostChosenOptions) lines.push(['option_choisie', o.code, '', o.count, '', '', '', '']);
    return '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }
}

function period(q: z.infer<typeof ReportQuery>, now: Date) {
  const to = q.to ? new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 365 * DAY);
  if (from >= to || to.getTime() - from.getTime() > 3 * 366 * DAY) {
    throw new BadRequestException({ code: 'INVALID_RANGE', detail: 'Période invalide (du ≤ au, trois ans au plus).' });
  }
  return { from, to };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Options retenues d'une configuration : tableau de codes, ou objet { code: vrai/quantité }. */
export function optionCodes(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (v && typeof v === 'object') return Object.entries(v).filter(([, x]) => Boolean(x)).map(([k]) => k);
  return [];
}

/** Cellule CSV : neutralise les formules (injection CSV) et échappe les guillemets. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
