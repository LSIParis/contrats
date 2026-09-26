import { Injectable, Logger } from '@nestjs/common';
import { findContractsForDeadlines, systemScope, uuidv7, withScope, type Scope } from '@lsi/persistence';
import { computeDeadlines, type ComputedDeadline, type DeadlineKind } from '@lsi/domain';
import { TenantConfigService } from '../tenant/tenant-config.service.js';

/**
 * Échéancier (02-cycle-de-vie.md §6).
 *
 * `recompute` rapproche la table `deadlines` de ce que le domaine calcule
 * (`computeDeadlines`, pure) : création des nouvelles échéances, passage en
 * OBSOLETE de celles qui n'ont plus lieu d'être (avenant, résiliation…),
 * passage en DONE de celles dont la date est passée. Puis il matérialise les
 * ALERTES aux seuils du tenant (défaut 90/60/30/7 j) dans `reminders` — le
 * mécanisme d'envoi existant (dédoublonnage en base, escalade) les porte.
 *
 * Idempotent : contraintes UNIQUE sur (contrat, nature, date) et sur
 * (contrat, nature de rappel, décalage, cycle). Deux recalculs concurrents ne
 * créent pas de doublon.
 */

/** Nature d'échéance → nature de rappel (enum ReminderKind). */
const REMINDER_KIND: Record<DeadlineKind, string> = {
  PERIOD_END: 'EXPIRY',
  NOTICE_DEADLINE: 'NOTICE_DEADLINE',
  PRICE_REVISION: 'PRICE_REVISION',
  RENEWAL_DECISION: 'RENEWAL_DECISION',
  CHATEL_NOTICE: 'CHATEL_NOTICE',
  TERMINATION_EFFECTIVE: 'TERMINATION_EFFECTIVE',
};

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const key = (kind: string, due: Date) => `${kind}@${dayOf(due).toISOString().slice(0, 10)}`;

export interface RecomputeResult {
  readonly created: number;
  readonly obsoleted: number;
  readonly remindersCreated: number;
}

@Injectable()
export class DeadlinesService {
  private readonly log = new Logger(DeadlinesService.name);

  constructor(private readonly config: TenantConfigService) {}

  /** Recalcul d'UN contrat, dans une transaction scopée existante. */
  async recompute(tx: any, contractId: string, thresholds: readonly number[], now: Date): Promise<RecomputeResult> {
    const c = await tx.contract.findUnique({ where: { id: contractId }, include: { customer: { select: { isConsumer: true } } } });
    if (!c) return { created: 0, obsoleted: 0, remindersCreated: 0 };

    const computed: ComputedDeadline[] = c.type === 'MAIN'
      ? computeDeadlines(
          {
            status: c.status,
            startDate: c.startDate,
            endDate: c.endDate,
            notice: { days: c.noticePeriodDays, months: c.noticePeriodMonths },
            renewalMode: c.renewalMode,
            renewalPeriodMonths: c.renewalPeriodMonths,
            chatelApplies: c.chatelNotice ?? c.customer?.isConsumer ?? false,
            terminationEffectiveDate: c.terminationEffectiveDate,
            // Prochaine révision du barème : fournie par la tarification (lot 3).
            nextPriceRevisionDate: await this.nextRevision(tx, contractId, now),
          },
          now,
        )
      : [];

    const existing: any[] = await tx.deadline.findMany({ where: { contractId, status: { in: ['OPEN', 'DONE'] } } });
    const wanted = new Map(computed.map((d) => [key(d.kind, d.dueDate), d]));
    const today = dayOf(now);
    let created = 0;
    let obsoleted = 0;
    let remindersCreated = 0;

    // Obsolescence : une échéance OUVERTE qui ne figure plus dans le calcul.
    for (const e of existing) {
      if (e.status === 'OPEN' && !wanted.has(key(e.kind, e.dueDate))) {
        await tx.deadline.update({ where: { id: e.id }, data: { status: 'OBSOLETE', computedAt: now } });
        await tx.reminder.updateMany({ where: { deadlineId: e.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
        obsoleted++;
      }
    }

    const byKey = new Map(existing.map((e) => [key(e.kind, e.dueDate), e]));
    for (const [k, d] of wanted) {
      const past = dayOf(d.dueDate) < today;
      let row = byKey.get(k);
      if (!row) {
        row = await tx.deadline.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId,
            kind: d.kind, dueDate: dayOf(d.dueDate), status: past ? 'DONE' : 'OPEN',
            details: d.details, computedAt: now,
          },
        });
        created++;
      } else if (row.status === 'OPEN' && past) {
        await tx.deadline.update({ where: { id: row.id }, data: { status: 'DONE', computedAt: now } });
        continue;
      }
      if (past) continue;
      remindersCreated += await this.materializeAlerts(tx, c, row, thresholds, now);
    }
    return { created, obsoleted, remindersCreated };
  }

  /**
   * Prochaine date de révision tarifaire. Point d'extension du lot 3
   * (`PricingService.nextRevisionDate`) ; sans barème, aucune.
   */
  protected async nextRevision(_tx: any, _contractId: string, _now: Date): Promise<Date | null> {
    return null;
  }

  /**
   * Alertes J-n d'une échéance. Même règle que les rappels historiques
   * (RM-25) : une alerte dont la date est déjà passée est créée
   * SKIPPED_OBSOLETE — le silence n'est jamais une donnée.
   *
   * Unicité des rappels : (contrat, nature, décalage, cycle). Une échéance
   * NOUVELLE de même nature (terme déplacé par un avenant) prend donc un
   * cycle supérieur. Les rappels historiques non rattachés (matérialisés à
   * l'activation, avant l'échéancier) qui correspondent à cette échéance sont
   * ADOPTÉS plutôt que dupliqués : une alerte n'est jamais envoyée deux fois.
   *
   * `createMany({ skipDuplicates })` (ON CONFLICT DO NOTHING) et non un
   * try/catch P2002 : dans une transaction PostgreSQL, une violation de
   * contrainte AVORTE la transaction entière (25P02), le catch ne rattrape rien.
   */
  private async materializeAlerts(tx: any, c: any, deadline: any, thresholds: readonly number[], now: Date): Promise<number> {
    const kind = REMINDER_KIND[deadline.kind as DeadlineKind];
    const due = dayOf(deadline.dueDate).getTime();
    const existing: any[] = await tx.reminder.findMany({ where: { contractId: c.id, kind } });

    const orphans = existing.filter(
      (r) => r.deadlineId === null && dayOf(r.dueAt).getTime() + r.offsetDays * DAY_MS === due,
    );
    if (orphans.length) {
      await tx.reminder.updateMany({ where: { id: { in: orphans.map((r) => r.id) } }, data: { deadlineId: deadline.id } });
    }
    const mine = [...existing.filter((r) => r.deadlineId === deadline.id), ...orphans];
    const cycle: number = mine.length
      ? mine[0].cycle
      : existing.length
        ? Math.max(...existing.map((r) => r.cycle)) + 1
        : c.reminderCycle;
    const have = new Set(mine.map((r) => r.offsetDays));

    const data = thresholds
      .filter((offsetDays) => !have.has(offsetDays))
      .map((offsetDays) => {
        const dueAt = new Date(due - offsetDays * DAY_MS);
        return {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: c.id,
          kind, offsetDays, cycle, dueAt, status: dueAt <= now ? 'SKIPPED_OBSOLETE' : 'PENDING',
          deadlineId: deadline.id, createdAt: now,
        };
      });
    if (!data.length) return 0;
    const r = await tx.reminder.createMany({ data, skipDuplicates: true });
    return r.count;
  }

  /** Recalcul d'un contrat dans son propre scope (après une mutation métier). */
  async recomputeInScope(scope: Scope, contractId: string, now: Date): Promise<RecomputeResult> {
    const thresholds = (await this.config.setting(scope, 'alerts.thresholdsDays')) as number[];
    return withScope(scope, (tx) => this.recompute(tx, contractId, thresholds, now));
  }

  /** Job quotidien : tous les contrats engagés, chacun dans son scope système. */
  async runAll(now: Date): Promise<{ contracts: number; created: number; obsoleted: number; reminders: number }> {
    const refs = await findContractsForDeadlines();
    const thresholdsByTenant = new Map<string, number[]>();
    const total = { contracts: 0, created: 0, obsoleted: 0, reminders: 0 };
    for (const ref of refs) {
      const scope = systemScope(ref.tenantId, ref.customerId);
      let thresholds = thresholdsByTenant.get(ref.tenantId);
      if (!thresholds) {
        thresholds = (await this.config.setting(scope, 'alerts.thresholdsDays')) as number[];
        thresholdsByTenant.set(ref.tenantId, thresholds);
      }
      try {
        const r = await withScope(scope, (tx) => this.recompute(tx, ref.id, thresholds!, now));
        total.contracts++;
        total.created += r.created;
        total.obsoleted += r.obsoleted;
        total.reminders += r.remindersCreated;
      } catch (e) {
        // Un contrat en erreur ne doit pas priver les autres de leur échéancier.
        this.log.error(`échéancier non recalculé pour ${ref.id} : ${(e as Error).message}`);
      }
    }
    if (total.created || total.obsoleted) {
      this.log.log(`échéancier : ${total.contracts} contrat(s), +${total.created} / -${total.obsoleted} échéance(s), ${total.reminders} alerte(s)`);
    }
    return total;
  }

  /** Lecture : échéances ouvertes d'une période (tableau de bord, API). */
  list(scope: Scope, from: Date, to: Date, contractId?: string) {
    return withScope(scope, (tx) =>
      tx.deadline.findMany({
        where: { status: 'OPEN', dueDate: { gte: dayOf(from), lte: dayOf(to) }, ...(contractId ? { contractId } : {}) },
        orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }],
        select: {
          id: true, contractId: true, customerId: true, kind: true, dueDate: true, details: true,
          contract: { select: { reference: true, title: true, status: true } },
        },
      }),
    );
  }
}
