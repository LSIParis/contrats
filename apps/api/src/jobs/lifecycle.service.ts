import { Injectable, Logger } from '@nestjs/common';
import {
  withScope,
  systemScope,
  uuidv7,
  findContractsToActivate,
  findContractsToExpire,
} from '@lsi/persistence';
import { applyEvent, planReminders, type ContractSnapshot } from '@lsi/domain';

/**
 * Avancement automatique du cycle de vie des contrats. (§7, RM-06/07/23)
 *
 * Balayé quotidiennement par le worker :
 *   - SIGNED → ACTIVE quand la date de début est atteinte, ce qui MATÉRIALISE
 *     les rappels J-90/60/30 (RM-23). Les rappels sont posés en base ici, pas
 *     calculés à l'envoi : un scheduler en panne ne les fait pas disparaître.
 *   - ACTIVE → EXPIRED (ou RENEWED si successeur signé) au terme, ce qui ANNULE
 *     les rappels encore en attente — un rappel obsolète est pire qu'aucun.
 *
 * La découverte est hors scope (fonctions SECURITY DEFINER), mais chaque
 * transition s'applique DANS le scope résolu, sous RLS, via le domaine — le
 * job ne décide pas de l'état, il constate une date et laisse le domaine
 * trancher.
 */
@Injectable()
export class LifecycleService {
  private readonly log = new Logger(LifecycleService.name);

  async run(now: Date): Promise<{ activated: number; expired: number }> {
    const activated = await this.activateDue(now);
    const expired = await this.expireDue(now);
    if (activated || expired) {
      this.log.log(`cycle de vie : ${activated} activé(s), ${expired} expiré(s)`);
    }
    return { activated, expired };
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

        let next;
        try {
          next = applyEvent(this.snapshot(c, false), { type: 'ACTIVATE' }, now);
        } catch (e) {
          this.log.warn(`activation ignorée sur ${c.id} : ${(e as Error).message}`);
          return false;
        }
        // RM-06 : si la prise d'effet est future, le domaine renvoie SIGNED
        // inchangé — on ne matérialise rien.
        if (next.status !== 'ACTIVE') return false;

        await tx.contract.update({
          where: { id: c.id },
          data: { status: 'ACTIVE', activatedAt: now, updatedAt: now },
        });
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
        if (!c || c.status !== 'ACTIVE') return false;

        // « Successeur signé » = renouvellement effectivement signé (RM-07).
        const successor = c.successorContractId
          ? await tx.contract.findUnique({ where: { id: c.successorContractId } })
          : null;
        const hasSignedSuccessor = !!successor?.signedAt;

        let next;
        try {
          next = applyEvent(this.snapshot(c, hasSignedSuccessor), { type: 'EXPIRE' }, now);
        } catch (e) {
          this.log.warn(`expiration ignorée sur ${c.id} : ${(e as Error).message}`);
          return false;
        }

        await tx.contract.update({
          where: { id: c.id },
          data: { status: next.status, updatedAt: now },
        });
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
    for (const d of drafts) {
      try {
        await tx.reminder.create({
          data: {
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
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') continue; // déjà matérialisé (RM-24)
        throw e;
      }
    }
  }

  /**
   * Snapshot plat pour le domaine. Seuls les champs lus par ACTIVATE/EXPIRE
   * comptent (dates, successeur) ; le reste est renseigné honnêtement mais
   * n'entre pas dans ces décisions.
   */
  private snapshot(c: any, hasSignedSuccessor: boolean): ContractSnapshot {
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      startDate: c.startDate,
      endDate: c.endDate,
      noticePeriodDays: c.noticePeriodDays,
      currentVersionId: c.currentVersionId,
      approvedVersionId: c.approvedVersionId,
      submittedByUserId: null,
      hasLsiSigner: true,
      hasClientSigner: true,
      hasRequiredAttachments: true,
      openAmendmentExists: false,
      hasSignedSuccessor,
      signedAt: c.signedAt,
      activatedAt: c.activatedAt,
      terminatedAt: c.terminatedAt,
    };
  }
}
