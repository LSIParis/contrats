import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { withScope, systemScope, resolveWebhookScope, uuidv7 } from '@lsi/persistence';
import { applyEvent, replanAfterEndDateChange, type NormalizedSignatureEvent } from '@lsi/domain';
import { DocusealAdapter } from '../signature/docuseal.adapter.js';
import { JOB_QUEUE, type CaptureProofJob, type JobQueue } from '../jobs/job-queue.port.js';

export type WebhookOutcome =
  | 'processed'
  | 'duplicate_ignored'
  | 'unknown_submission'
  | 'unsupported_event'
  | 'rejected'
  | 'closed_ignored';

/**
 * Statuts CLOS d'une signature_request : plus rien ne doit les rouvrir.
 *
 * REVOKED est le cas déclencheur (revoke ⇄ webhook en vol), mais un webhook
 * tardif sur n'importe quel statut définitivement clos doit être inerte pour
 * la même raison — CREATING/SENT/PARTIALLY_COMPLETED restent volontairement
 * hors de cet ensemble : ce sont les statuts ACTIFS que le webhook doit
 * justement pouvoir faire progresser.
 */
const CLOSED_REQUEST_STATUSES = new Set(['REVOKED', 'DECLINED', 'EXPIRED', 'COMPLETED', 'FAILED']);

/**
 * Traitement des webhooks DocuSeal. (§11.4)
 *
 * L'ORDRE DES ÉTAPES EST LA SÉCURITÉ. Le changer, c'est ouvrir une brèche :
 *
 *   1. vérifier le HMAC sur le CORPS BRUT — avant tout parsing
 *   2. parser
 *   3. idempotence : contrainte UNIQUE en base, pas un `if`
 *   4. RÉSOUDRE LE SCOPE DEPUIS NOTRE BASE — jamais depuis le payload
 *   5. sonder la divergence avec la metadata (diagnostic, pas autorisation)
 *   6. appliquer dans le scope résolu
 */
@Injectable()
export class DocusealWebhookService {
  private readonly log = new Logger(DocusealWebhookService.name);

  constructor(
    private readonly provider: DocusealAdapter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  async handle(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ status: WebhookOutcome }> {
    // --- 1. HMAC sur le corps brut, AVANT de parser -----------------------
    // Parser d'abord exposerait l'analyseur JSON à un corps non authentifié.
    const verification = this.provider.verifyWebhook(rawBody, headers);
    if (!verification.valid) {
      this.log.warn(`webhook rejeté : ${verification.reason}`);
      throw new UnauthorizedException('Signature invalide');
    }

    // --- 2. Parser --------------------------------------------------------
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Corps illisible');
    }

    const event = this.provider.parseWebhook(payload);
    if (!event) return { status: 'unsupported_event' };

    // --- 3. Résoudre le scope DEPUIS NOTRE BASE ---------------------------
    //
    // LE CŒUR DU DISPOSITIF.
    //
    // Un webhook arrive sans session : le scope ne peut pas venir d'un
    // cookie. Il vient de signature_requests, via la contrainte
    // UNIQUE (provider, provider_submission_id) — qui mappe de façon
    // déterministe une submission externe vers le couple (tenant, customer)
    // que NOUS avons écrit à la création.
    //
    // Cette lecture est nécessairement HORS scope : on cherche justement
    // QUEL est le scope. C'est, avec la découverte des rappels (§12.3), la
    // seule requête non scopée de l'application — et elle passe par le rôle
    // `lsi_webhook`, borné à six colonnes d'identité d'une seule table.
    const sigReq = await resolveWebhookScope('DOCUSEAL', event.providerSubmissionId);
    if (!sigReq) {
      // 200 : DocuSeal réessaie 48 h sur les 4xx/5xx, et faire réessayer un
      // événement définitivement non traitable n'est que du bruit.
      this.log.warn(`webhook orphelin, submission=${event.providerSubmissionId}`);
      return { status: 'unknown_submission' };
    }

    // --- 4. Sonde de divergence -------------------------------------------
    //
    // Non nécessaire à la sécurité — l'étape 3 suffit, puisque le scope ne
    // vient pas du payload. C'est une SONDE : si elle se déclenche un jour,
    // c'est qu'il se passe quelque chose qui mérite un humain.
    const claimed = event.untrustedMetadata?.['tenant_id'];
    if (claimed && claimed !== sigReq.tenantId) {
      this.log.error(
        `ALERTE SÉCURITÉ : metadata webhook incohérente avec la base. ` +
          `submission=${event.providerSubmissionId} prétendu=${claimed} réel=${sigReq.tenantId}`,
      );
      return { status: 'rejected' };
    }

    // --- 5. Appliquer DANS le scope résolu --------------------------------
    const scope = systemScope(sigReq.tenantId, sigReq.customerId);
    const result = await withScope(scope, async (tx) => {
      // Idempotence par contrainte UNIQUE (provider_event_id), pas par un
      // `if` : deux webhooks concurrents passeraient un `if`, pas une
      // contrainte de base (EC-05).
      try {
        await tx.signatureEvent.create({
          data: {
            id: uuidv7(),
            tenantId: sigReq.tenantId,
            customerId: sigReq.customerId,
            signatureRequestId: sigReq.signatureRequestId,
            providerEventId: event.eventId,
            eventType: event.kind,
            submitterEmail: event.submitterEmail,
            occurredAt: event.occurredAt,
            receivedAt: new Date(),
            ip: event.ip,
            userAgent: event.userAgent,
            rawPayload: event.rawPayload as object,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return { status: 'duplicate_ignored' as const, captureJob: null };
        throw e;
      }

      // Garde : un webhook déjà en vol pour une demande qui vient d'être
      // CLOSE (typiquement REVOKED entre-temps par un utilisateur) ne doit
      // RIEN modifier. Sans cette garde, un FORM_COMPLETED tardif sur une
      // demande REVOKED repasserait le signataire à SIGNED et la demande à
      // PARTIALLY_COMPLETED/COMPLETED — ré-entrant dans l'index partiel
      // unique signature_requests_one_active et bloquant tout renvoi
      // ultérieur sans qu'une révocation ne soit plus jamais possible.
      // L'événement reste journalisé ci-dessus (piste d'audit) ; seul
      // l'effet métier est court-circuité.
      const current = await tx.signatureRequest.findUnique({
        where: { id: sigReq.signatureRequestId },
        select: { status: true },
      });
      if (current && CLOSED_REQUEST_STATUSES.has(current.status)) {
        this.log.warn(
          `webhook ignoré : demande ${sigReq.signatureRequestId} déjà ${current.status} ` +
            `(événement ${event.kind} tardif)`,
        );
        await tx.signatureEvent.updateMany({
          where: { providerEventId: event.eventId },
          data: { processedAt: new Date() },
        });
        return { status: 'closed_ignored' as const, captureJob: null };
      }

      const captureJob = await this.applyBusinessEffect(tx, sigReq, event);

      await tx.signatureEvent.updateMany({
        where: { providerEventId: event.eventId },
        data: { processedAt: new Date() },
      });

      return { status: 'processed' as const, captureJob };
    });

    // --- 6. Enfiler la capture de preuve APRÈS COMMIT ---------------------
    //
    // Jamais dans la transaction : un rollback laisserait un job pointant sur
    // un état jamais persisté. La capture est ASYNCHRONE — on ne bloque pas la
    // réponse au webhook sur le téléchargement du PDF signé (§11.6). Si
    // l'enfilement échoue, la réconciliation (EC-06) rattrape.
    if (result.status === 'processed' && result.captureJob) {
      try {
        await this.queue.enqueueCaptureProof(result.captureJob);
      } catch (e) {
        this.log.error(
          `enfilement capture échoué (rattrapé par réconciliation) : ${(e as Error).message}`,
        );
      }
    }

    return { status: result.status };
  }

  /**
   * Applique l'effet métier de l'événement.
   *
   * Renvoie un job de capture de preuve à enfiler APRÈS commit lorsque toutes
   * les signatures sont réunies (COMPLETED), sinon null.
   */
  private async applyBusinessEffect(
    tx: any,
    sigReq: { signatureRequestId: string; contractId: string; tenantId: string; customerId: string },
    event: NormalizedSignatureEvent,
  ): Promise<CaptureProofJob | null> {
    const now = new Date();

    // Rapprochement par external_id, JAMAIS par email : deux signataires
    // peuvent partager une adresse (assistante), et l'email est modifiable
    // côté DocuSeal (§11.5).
    const signer = event.externalSignerId
      ? await tx.contractSigner.findUnique({ where: { id: event.externalSignerId } })
      : await tx.contractSigner.findFirst({
          where: { providerSubmitterId: event.providerSubmitterId },
        });

    switch (event.kind) {
      case 'FORM_VIEWED': {
        if (signer && signer.status === 'SENT') {
          await tx.contractSigner.update({
            where: { id: signer.id },
            data: { status: 'VIEWED', updatedAt: now },
          });
        }
        return null; // aucun effet sur le contrat
      }

      case 'FORM_STARTED':
        return null; // journalisé, sans effet

      case 'FORM_DECLINED': {
        if (signer) {
          await tx.contractSigner.update({
            where: { id: signer.id },
            data: {
              status: 'DECLINED',
              declinedAt: now,
              declineReason: event.declineReason,
              updatedAt: now,
            },
          });
        }
        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: { status: 'DECLINED', lastSyncedAt: now, updatedAt: now },
        });
        await this.transition(tx, sigReq.contractId, { type: 'SIGNER_DECLINED', reason: event.declineReason ?? '' }, now);
        return null;
      }

      case 'FORM_COMPLETED': {
        if (signer) {
          await tx.contractSigner.update({
            where: { id: signer.id },
            data: { status: 'SIGNED', signedAt: now, updatedAt: now },
          });
        }

        // On relit l'état RÉEL des signataires plutôt que de croire le
        // payload : c'est notre base qui fait foi sur « tous ont signé ».
        const remaining = await tx.contractSigner.count({
          where: { contractId: sigReq.contractId, status: { not: 'SIGNED' } },
        });
        const allSigned = remaining === 0;

        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: {
            status: allSigned ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
        await this.transition(tx, sigReq.contractId, { type: 'SIGNER_SIGNED', allSigned }, now);

        // Renouvellement (§6.12) : si le contrat qui vient d'être totalement
        // signé est un SUCCESSEUR de renouvellement, sa signature vaut
        // acceptation de l'offre — la RenewalRequest PENDING correspondante
        // passe ACCEPTED. `updateMany` sur PENDING est idempotent : un
        // rejeu du webhook ou une RenewalRequest déjà décidée est un no-op.
        if (allSigned) {
          const signed = await tx.contract.findUnique({
            where: { id: sigReq.contractId },
            select: { predecessorContractId: true },
          });
          if (signed?.predecessorContractId) {
            await tx.renewalRequest.updateMany({
              where: { newContractId: sigReq.contractId, status: 'PENDING' },
              data: { status: 'ACCEPTED', decidedAt: now },
            });
          }

          // Avenant (§6.12, RM-18) : à la signature complète d'un avenant,
          // reporter ses champs sur le parent + régénérer ses rappels (EC-12).
          // Idempotent : l'événement webhook est dédupliqué (EC-05), donc ceci
          // ne s'exécute qu'une fois.
          const av = await tx.contract.findUnique({
            where: { id: sigReq.contractId },
            select: { type: true, parentContractId: true, endDate: true, amountCents: true },
          });
          if (av?.type === 'AMENDMENT' && av.parentContractId) {
            const parent = await tx.contract.findUnique({
              where: { id: av.parentContractId },
              select: { id: true, tenantId: true, customerId: true, status: true, noticePeriodDays: true, reminderCycle: true },
            });
            if (parent) {
              if (parent.status === 'ACTIVE' && av.endDate) {
                const { newCycle, reminders } = replanAfterEndDateChange(
                  { endDate: av.endDate, noticePeriodDays: parent.noticePeriodDays, reminderCycle: parent.reminderCycle },
                  now,
                );
                await tx.reminder.updateMany({ where: { contractId: parent.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                await tx.contract.update({ where: { id: parent.id }, data: { endDate: av.endDate, amountCents: av.amountCents, reminderCycle: newCycle, updatedAt: now } });
                for (const d of reminders) {
                  await tx.reminder.create({ data: {
                    id: uuidv7(), tenantId: parent.tenantId, customerId: parent.customerId, contractId: parent.id,
                    kind: d.kind, offsetDays: d.offsetDays, cycle: d.cycle, dueAt: d.dueAt, status: d.status, createdAt: now,
                  }});
                }
              } else {
                await tx.contract.update({ where: { id: parent.id }, data: { endDate: av.endDate, amountCents: av.amountCents, updatedAt: now } });
              }
            }
          }
        }

        // À complétion TOTALE : capturer le PDF signé et la piste d'audit
        // (§11.6). Job ASYNCHRONE, enfilé APRÈS commit par handle() — jamais
        // en ligne : DocuSeal réessaie sur timeout, et télécharger ici
        // bloquerait la réponse et risquerait un double traitement.
        if (allSigned) {
          return {
            signatureRequestId: sigReq.signatureRequestId,
            tenantId: sigReq.tenantId,
            customerId: sigReq.customerId,
          };
        }
        return null;
      }

      case 'SUBMISSION_EXPIRED': {
        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: { status: 'EXPIRED', lastSyncedAt: now, updatedAt: now },
        });
        return null;
      }

      case 'SUBMISSION_COMPLETED': {
        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: { lastSyncedAt: now, updatedAt: now },
        });
        return null;
      }
    }

    return null;
  }

  /**
   * Applique une transition via le DOMAINE.
   *
   * Le webhook ne décide pas de l'état : il rapporte un fait, le domaine
   * tranche. RM-14 : le statut de signature n'est modifié que par le SYSTEM
   * sur la foi d'un webhook vérifié — mais toujours à travers les mêmes
   * règles que le reste.
   */
  private async transition(tx: any, contractId: string, event: any, now: Date): Promise<void> {
    const c = await tx.contract.findUnique({ where: { id: contractId } });
    if (!c) return;

    const snapshot = {
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
      hasSignedSuccessor: c.successorContractId !== null,
      signedAt: c.signedAt,
      activatedAt: c.activatedAt,
      terminatedAt: c.terminatedAt,
    };

    try {
      const next = applyEvent(snapshot, event, now);
      await tx.contract.update({
        where: { id: contractId },
        data: {
          status: next.status,
          signedAt: next.signedAt ?? null,
          updatedAt: now,
        },
      });
    } catch (e) {
      // Un webhook en retard sur un contrat déjà annulé est un cas RÉEL, pas
      // un incident : on journalise et on laisse l'état en place plutôt que
      // de renvoyer 5xx, ce qui déclencherait 48 h de réessais inutiles.
      this.log.warn(`transition ignorée sur ${contractId} : ${(e as Error).message}`);
    }
  }
}
