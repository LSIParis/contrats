import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { withScope, systemScope, resolveWebhookScope, uuidv7 } from '@lsi/persistence';
import { applyEvent, type NormalizedSignatureEvent } from '@lsi/domain';
import { DocusealAdapter } from '../signature/docuseal.adapter.js';

export type WebhookOutcome =
  | 'processed'
  | 'duplicate_ignored'
  | 'unknown_submission'
  | 'unsupported_event'
  | 'rejected';

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

  constructor(private readonly provider: DocusealAdapter) {}

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
    return withScope(scope, async (tx) => {
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
        if (e?.code === 'P2002') return { status: 'duplicate_ignored' as const };
        throw e;
      }

      await this.applyBusinessEffect(tx, sigReq, event);

      await tx.signatureEvent.updateMany({
        where: { providerEventId: event.eventId },
        data: { processedAt: new Date() },
      });

      return { status: 'processed' as const };
    });
  }

  private async applyBusinessEffect(
    tx: any,
    sigReq: { signatureRequestId: string; contractId: string },
    event: NormalizedSignatureEvent,
  ): Promise<void> {
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
        return; // aucun effet sur le contrat
      }

      case 'FORM_STARTED':
        return; // journalisé, sans effet

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
        return;
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

        // TODO(W-05) : à SIGNED, enfiler le téléchargement du PDF signé et
        // de la piste d'audit (§11.6). Job ASYNCHRONE, jamais ici : DocuSeal
        // réessaie sur timeout, et un timeout provoquerait un double
        // traitement.
        return;
      }

      case 'SUBMISSION_EXPIRED': {
        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: { status: 'EXPIRED', lastSyncedAt: now, updatedAt: now },
        });
        return;
      }

      case 'SUBMISSION_COMPLETED': {
        await tx.signatureRequest.update({
          where: { id: sigReq.signatureRequestId },
          data: { lastSyncedAt: now, updatedAt: now },
        });
        return;
      }
    }
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
