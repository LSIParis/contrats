import { Inject, Injectable, Logger } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import type { EmailSender } from '@lsi/domain';
import { EMAIL_SENDER } from '../notifications/email.token.js';

const LATE_MARGIN_MS = 24 * 60 * 60 * 1_000;

interface OutMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}
interface InternalNote {
  readonly userId: string;
  readonly subject: string;
  readonly body: string;
}
interface Plan {
  readonly reminderId: string;
  readonly contractId: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly offset: number;
  readonly dueAt: Date;
  readonly mails: OutMail[];
  readonly notes: InternalNote[];
}

/** Objet des alertes, par nature d'échéance (02-cycle-de-vie §6). */
const REMINDER_TITLE: Record<string, string> = {
  EXPIRY: 'Échéance',
  NOTICE_DEADLINE: 'Date limite de dénonciation',
  RENEWAL_DECISION: 'Décision de renouvellement',
  CHATEL_NOTICE: 'Information loi Chatel à envoyer',
  PRICE_REVISION: 'Révision tarifaire',
  TERMINATION_EFFECTIVE: 'Prise d’effet de la résiliation',
};

function reminderSentence(kind: string, label: string, due: string, offset: number): string {
  switch (kind) {
    case 'NOTICE_DEADLINE':
      return `Dernier jour pour dénoncer le contrat ${label} : ${due} (dans ${offset} jours). Au-delà, la période suivante est due.`;
    case 'RENEWAL_DECISION':
      return `Le renouvellement exprès du contrat ${label} doit être décidé au plus tard le ${due} (dans ${offset} jours).`;
    case 'CHATEL_NOTICE':
      return `Contrat ${label} (client consommateur ou non-professionnel) : l'information sur la faculté de ne pas reconduire (art. L215-1 C. conso.) peut être envoyée à partir du ${due}, et au plus tard un mois avant la date limite de dénonciation.`;
    case 'PRICE_REVISION':
      return `Révision tarifaire du contrat ${label} prévue le ${due} (dans ${offset} jours) : vérifier la publication de l'indice.`;
    case 'TERMINATION_EFFECTIVE':
      return `La résiliation du contrat ${label} prend effet le ${due} (dans ${offset} jours).`;
    default:
      return `Le contrat ${label} arrive à échéance le ${due} (dans ${offset} jours).`;
  }
}

function fmtDate(d: Date | null): string {
  if (!d) return 'date non définie';
  return d.toISOString().slice(0, 10).split('-').reverse().join('/');
}

/**
 * Envoi d'un rappel d'échéance. (§12.3, RM-26, RM-27)
 *
 * Le découpage suit celui de la capture de preuve : DÉCIDER en base (scope,
 * RLS), ENVOYER hors transaction, puis MARQUER. On préfère structurellement un
 * doublon d'email à un rappel perdu — c'est exactement le risque que cette
 * application existe pour éliminer.
 *
 * RM-27 :
 *   - J-90 : interne seul (à LSI de préparer sa proposition).
 *   - J-60 / J-30 : + email client, si ACTIVE et sans renouvellement en cours.
 *   - J-30 : + escalade MSP_ADMIN si AUCUNE demande de renouvellement.
 */
@Injectable()
export class ReminderSendService {
  private readonly log = new Logger(ReminderSendService.name);

  constructor(@Inject(EMAIL_SENDER) private readonly email: EmailSender) {}

  async send(scope: Scope, reminderId: string, now: Date): Promise<boolean> {
    // --- 1. Décider (dans le scope, RLS active) ---------------------------
    const plan = await withScope(scope, (tx) => this.buildPlan(tx, reminderId));
    if (!plan) return false; // déjà envoyé/annulé, ou contrat introuvable

    // --- 2. Envoyer HORS transaction --------------------------------------
    for (const m of plan.mails) {
      await this.email.send({ to: m.to, subject: m.subject, text: m.text });
    }

    // --- 3. Marquer (nouvelle transaction) --------------------------------
    await withScope(scope, async (tx) => {
      const r = await tx.reminder.findUnique({ where: { id: plan.reminderId } });
      if (!r || r.status !== 'PENDING') return; // un autre worker a gagné

      // Dédoublonnage par dedupKey UNIQUE, en ON CONFLICT DO NOTHING : un
      // try/catch P2002 dans la transaction la laisserait AVORTÉE (25P02) et
      // ferait échouer le marquage SENT du rappel qui suit.
      await tx.notification.createMany({
        data: plan.notes.map((n) => ({
          id: uuidv7(),
          tenantId: plan.tenantId,
          customerId: plan.customerId,
          recipientUserId: n.userId,
          channel: 'EMAIL',
          type: `REMINDER_J${plan.offset}`,
          subject: n.subject,
          body: n.body,
          relatedContractId: plan.contractId,
          relatedReminderId: plan.reminderId,
          status: 'SENT',
          sentAt: now,
          dedupKey: `rem:${plan.reminderId}:u:${n.userId}`,
          createdAt: now,
        })),
        skipDuplicates: true,
      });

      await tx.reminder.update({
        where: { id: plan.reminderId },
        data: {
          status: 'SENT',
          sentAt: now,
          late: now.getTime() - plan.dueAt.getTime() > LATE_MARGIN_MS,
          attempts: { increment: 1 },
        },
      });
    });

    this.log.log(`rappel J-${plan.offset} envoyé (contrat ${plan.contractId})`);
    return true;
  }

  private async buildPlan(tx: any, reminderId: string): Promise<Plan | null> {
    const r = await tx.reminder.findUnique({ where: { id: reminderId } });
    if (!r || r.status !== 'PENDING') return null;

    const c = await tx.contract.findUnique({ where: { id: r.contractId } });
    if (!c) return null;

    const owner = await tx.user.findFirst({ where: { id: c.ownerUserId } });
    const renewals = await tx.renewalRequest.findMany({ where: { contractId: c.id } });
    const renewalInProgress = renewals.some((x: any) => x.status === 'PENDING');
    const hasAnyRenewal = renewals.length > 0;

    const offset: number = r.offsetDays;
    const label = `${c.reference} — ${c.title}`;
    const term = fmtDate(c.endDate);
    // Date de l'échéance qui a produit le rappel (échéancier v2) ; à défaut, le terme.
    const deadline = r.deadlineId ? await tx.deadline.findUnique({ where: { id: r.deadlineId } }) : null;
    const due = fmtDate(deadline?.dueDate ?? c.endDate);
    const mails: OutMail[] = [];
    const notes: InternalNote[] = [];
    // Les messages client et l'escalade ne concernent que l'arrivée du TERME.
    const isExpiry = r.kind === 'EXPIRY';

    // Interne — toujours (owner / account manager).
    if (owner) {
      const subject = `${REMINDER_TITLE[r.kind as string] ?? 'Échéance'} J-${offset} : ${label}`;
      const body = `${reminderSentence(r.kind as string, label, due, offset)}\nStatut actuel : ${c.status}.`;
      notes.push({ userId: owner.id, subject, body });
      mails.push({ to: owner.email, subject, text: body });
    }

    // Client — J-60 / J-30, si ACTIVE et sans renouvellement en cours (RM-27).
    if (isExpiry && (offset === 60 || offset === 30) && c.status === 'ACTIVE' && !renewalInProgress) {
      const contact =
        (await tx.customerContact.findFirst({
          where: { customerId: c.customerId, isPrimary: true },
        })) ?? (await tx.customerContact.findFirst({ where: { customerId: c.customerId } }));
      if (contact) {
        mails.push({
          to: contact.email,
          subject: `Renouvellement de votre contrat ${c.reference}`,
          text:
            `Bonjour ${contact.firstName},\n\n` +
            `Votre contrat ${label} arrive à échéance le ${term}. ` +
            `Nous reviendrons vers vous pour son renouvellement.\n\nLSI Maintenance`,
        });
      }
    }

    // Escalade — J-30, si AUCUNE démarche de renouvellement (RM-27).
    if (isExpiry && offset === 30 && !hasAnyRenewal) {
      const admins = await tx.user.findMany({
        where: { status: 'ACTIVE', roles: { some: { role: { code: 'MSP_ADMIN' } } } },
      });
      for (const a of admins) {
        const subject = `ESCALADE — aucun renouvellement engagé : ${label}`;
        const body =
          `Le contrat ${label} arrive à échéance dans 30 jours (${term}) ` +
          `et AUCUNE demande de renouvellement n'a été initiée.`;
        notes.push({ userId: a.id, subject, body });
        mails.push({ to: a.email, subject, text: body });
      }
    }

    return {
      reminderId: r.id,
      contractId: c.id,
      customerId: c.customerId,
      tenantId: c.tenantId,
      offset,
      dueAt: r.dueAt,
      mails,
      notes,
    };
  }
}
