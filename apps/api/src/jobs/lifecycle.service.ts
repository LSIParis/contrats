import { Injectable, Logger } from '@nestjs/common';
import {
  withScope,
  systemScope,
  uuidv7,
  findContractsToActivate,
  findContractsToExpire,
  findTerminationsDue,
  findTacitRenewalsDue,
  findExpressRenewalsToOpen,
} from '@lsi/persistence';
import { applyEvent, nextPeriodEnd, planReminders, type ContractEvent } from '@lsi/domain';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';

/**
 * Avancement automatique du cycle de vie des contrats. (§7, RM-06/07/23)
 *
 * Balayé quotidiennement par le worker :
 *   - SIGNED → ACTIVE quand la date de début est atteinte, ce qui MATÉRIALISE
 *     les rappels J-90/60/30 (RM-23). Les rappels sont posés en base ici, pas
 *     calculés à l'envoi : un scheduler en panne ne les fait pas disparaître.
 *   - ACTIVE → EXPIRED (ou RENEWED si successeur signé) au terme, ce qui ANNULE
 *     les rappels encore en attente — un rappel obsolète est pire qu'aucun.
 *   - TERMINATION_PENDING → TERMINATED à la date d'effet de la résiliation
 *     (02-cycle-de-vie §3), ce qui annule aussi les rappels en attente.
 *
 * La découverte est hors scope (fonctions SECURITY DEFINER), mais chaque
 * transition s'applique DANS le scope résolu, sous RLS, via le domaine — le
 * job ne décide pas de l'état, il constate une date et laisse le domaine
 * trancher.
 */
@Injectable()
export class LifecycleService {
  private readonly log = new Logger(LifecycleService.name);

  async run(now: Date): Promise<{ activated: number; expired: number; terminated: number; renewed: number; renewalsOpened: number }> {
    const activated = await this.activateDue(now);
    // Ordre : reconduire AVANT d'expirer — un contrat tacitement reconduit ne
    // doit jamais être vu échu (la découverte d'expiration l'exclut aussi).
    const renewed = await this.renewTacit(now);
    const renewalsOpened = await this.openExpressRenewals(now);
    const expired = await this.expireDue(now);
    const terminated = await this.completeTerminations(now);
    if (activated || expired || terminated || renewed || renewalsOpened) {
      this.log.log(
        `cycle de vie : ${activated} activé(s), ${renewed} reconduit(s), ${renewalsOpened} renouvellement(s) ouvert(s), ` +
          `${expired} expiré(s), ${terminated} résilié(s)`,
      );
    }
    return { activated, expired, terminated, renewed, renewalsOpened };
  }

  /**
   * Reconduction TACITE (V2-H10) : la période échue sans dénonciation est
   * prolongée d'une durée de reconduction, autant de fois que nécessaire pour
   * rattraper une interruption du job. Chaque période est tracée
   * (contract_periods, TACIT_RENEWAL) et chaque prolongation passe par la
   * machine (RENEW_PERIOD, acteur SYSTEM).
   */
  private async renewTacit(now: Date): Promise<number> {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let n = 0;
    for (const ref of await findTacitRenewalsDue()) {
      const ok = await withScope(systemScope(ref.tenantId, ref.customerId), async (tx) => {
        let c = await tx.contract.findUnique({ where: { id: ref.id } });
        if (!c || c.renewalMode !== 'TACIT' || !c.renewalPeriodMonths || !c.endDate) return false;
        let guard = 0;
        while (c.endDate && c.endDate < today && guard++ < 50) {
          const currentEnd: Date = c.endDate;
          const newEnd = nextPeriodEnd(currentEnd, c.renewalPeriodMonths!);
          const event: ContractEvent = { type: 'RENEW_PERIOD', newEndDate: newEnd };
          let next;
          try {
            // RENEW_PERIOD n'est admis que depuis RENEWAL_DUE : un contrat ACTIVE
            // passe d'abord par OPEN_RENEWAL (trace complète de la reconduction).
            if (c.status === 'ACTIVE') {
              const open: ContractEvent = { type: 'OPEN_RENEWAL' };
              await persistTransition(tx, c.id, open, applyEvent(toContractSnapshot(c), open, now), now);
              c = (await tx.contract.findUnique({ where: { id: c.id } }))!;
            }
            next = applyEvent(toContractSnapshot(c), event, now);
          } catch (e) {
            this.log.warn(`reconduction impossible pour ${c.id} : ${(e as Error).message}`);
            return false;
          }
          const start = new Date(currentEnd.getTime() + 86_400_000);
          const last = await tx.contractPeriod.aggregate({ where: { contractId: c.id }, _max: { periodNumber: true } });
          await tx.contractPeriod.create({
            data: {
              id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: c.id,
              periodNumber: (last._max.periodNumber ?? 0) + 1, kind: 'TACIT_RENEWAL',
              startDate: start, endDate: newEnd, createdAt: now,
            },
          });
          await persistTransition(tx, c.id, event, next, now);
          c = (await tx.contract.findUnique({ where: { id: c.id } }))!;
        }
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  /** Renouvellement EXPRÈS : à la date limite de dénonciation, une décision est attendue. */
  private async openExpressRenewals(now: Date): Promise<number> {
    let n = 0;
    for (const ref of await findExpressRenewalsToOpen()) {
      const ok = await withScope(systemScope(ref.tenantId, ref.customerId), async (tx) => {
        const c = await tx.contract.findUnique({ where: { id: ref.id } });
        if (!c || c.status !== 'ACTIVE') return false;
        const event: ContractEvent = { type: 'OPEN_RENEWAL' };
        try {
          await persistTransition(tx, c.id, event, applyEvent(toContractSnapshot(c), event, now), now);
        } catch (e) {
          this.log.warn(`ouverture du renouvellement impossible pour ${c.id} : ${(e as Error).message}`);
          return false;
        }
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  private async completeTerminations(now: Date): Promise<number> {
    const candidates = await findTerminationsDue();
    let n = 0;
    for (const ref of candidates) {
      const ok = await withScope(systemScope(ref.tenantId, ref.customerId), async (tx) => {
        const c = await tx.contract.findUnique({ where: { id: ref.id } });
        if (!c || c.status !== 'TERMINATION_PENDING') return false;
        const event: ContractEvent = { type: 'COMPLETE_TERMINATION' };
        let next;
        try {
          next = applyEvent(toContractSnapshot(c), event, now);
        } catch (e) {
          this.log.warn(`résiliation non achevée sur ${c.id} : ${(e as Error).message}`);
          return false;
        }
        await persistTransition(tx, c.id, event, next, now);
        await tx.reminder.updateMany({
          where: { contractId: c.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  private async activateDue(now: Date): Promise<number> {
    const candidates = await findContractsToActivate();
    let n = 0;
    for (const ref of candidates) {
      const ok = await withScope(systemScope(ref.tenantId, ref.customerId), async (tx) => {
        const c = await tx.contract.findUnique({ where: { id: ref.id } });
        if (!c || c.status !== 'SIGNED') return false;
        // Un AVENANT ne doit jamais avoir de cycle de vie autonome : il
        // modifie son parent (RM-18) et ne porte pas ses propres rappels.
        // La découverte (SECURITY DEFINER) ne filtre que status+startDate,
        // sans distinguer le type — c'est ICI qu'on l'exclut, avant
        // activation ET avant matérialisation, sans quoi le client recevrait
        // les rappels J-90/60/30 EN DOUBLE (les siens + ceux du parent).
        // Un avenant signé REST en SIGNED : c'est le comportement MVP
        // documenté (RM-19, slot d'avenant ouvert).
        if (c.type === 'AMENDMENT') return false;

        const event: ContractEvent = { type: 'ACTIVATE' };
        let next;
        try {
          next = applyEvent(toContractSnapshot(c), event, now);
        } catch (e) {
          this.log.warn(`activation ignorée sur ${c.id} : ${(e as Error).message}`);
          return false;
        }
        // RM-06 : si la prise d'effet est future, le domaine renvoie SIGNED
        // inchangé — on ne matérialise rien.
        if (next.status !== 'ACTIVE') return false;

        await persistTransition(tx, c.id, event, next, now);
        await this.materializeReminders(tx, c, now);
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  private async expireDue(now: Date): Promise<number> {
    const candidates = await findContractsToExpire();
    let n = 0;
    for (const ref of candidates) {
      const ok = await withScope(systemScope(ref.tenantId, ref.customerId), async (tx) => {
        const c = await tx.contract.findUnique({ where: { id: ref.id } });
        if (!c || (c.status !== 'ACTIVE' && c.status !== 'RENEWAL_DUE')) return false;

        // « Successeur signé » = renouvellement effectivement signé (RM-07).
        const successor = c.successorContractId
          ? await tx.contract.findUnique({ where: { id: c.successorContractId } })
          : null;
        const hasSignedSuccessor = !!successor?.signedAt;

        const event: ContractEvent = { type: 'EXPIRE' };
        let next;
        try {
          next = applyEvent(toContractSnapshot(c, { hasSignedSuccessor }), event, now);
        } catch (e) {
          this.log.warn(`expiration ignorée sur ${c.id} : ${(e as Error).message}`);
          return false;
        }

        await persistTransition(tx, c.id, event, next, now);
        // RM-07 : annuler les rappels encore en attente du contrat expiré.
        await tx.reminder.updateMany({
          where: { contractId: c.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  /**
   * Matérialise les rappels d'un contrat activé. (RM-23, RM-24)
   *
   * Idempotent par la contrainte UNIQUE (contract_id, kind, offset_days, cycle)
   * — pas par un `if` : deux balayages concurrents ne créeraient pas de doublon.
   */
  private async materializeReminders(tx: any, c: any, now: Date): Promise<void> {
    const drafts = planReminders(
      { endDate: c.endDate, noticePeriodDays: c.noticePeriodDays, reminderCycle: c.reminderCycle },
      now,
    );
    // createMany + skipDuplicates (ON CONFLICT DO NOTHING) : dans une
    // transaction PostgreSQL, une violation d'unicité rattrapée par un
    // try/catch laisserait la transaction AVORTÉE (25P02) et ferait échouer
    // l'activation elle-même.
    await tx.reminder.createMany({
      data: drafts.map((d) => ({
        id: uuidv7(),
        tenantId: c.tenantId,
        customerId: c.customerId,
        contractId: c.id,
        kind: d.kind,
        offsetDays: d.offsetDays,
        cycle: d.cycle,
        dueAt: d.dueAt,
        status: d.status,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
  }
}
