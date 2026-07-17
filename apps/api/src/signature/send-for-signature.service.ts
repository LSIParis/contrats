import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import {
  applyEvent,
  InvalidTransitionError,
  BusinessRuleError,
  ProviderError,
  type ESignatureProvider,
  type DocumentRenderer,
  type SubmitterCommand,
} from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { ObjectStorage } from '../documents/object-storage.js';
import type { SendForSignatureDto } from '../contracts/dto/send-for-signature.dto.js';

/**
 * Envoi en signature. (§11.2, §11.3, §11.8, EC-04)
 *
 * LA FRONTIÈRE TRANSACTIONNELLE EST LE POINT DÉLICAT.
 *
 * L'appel au provider est de l'I/O réseau : il ne doit PAS être dans la
 * transaction. Une transaction ouverte pendant un appel HTTP lent tient des
 * verrous pendant des secondes, et un provider qui rame devient un incident
 * de base de données.
 *
 * D'où trois temps :
 *   tx1  : valider, créer les signataires, créer signature_request CREATING
 *   I/O  : rendre le PDF, appeler le provider — HORS transaction
 *   tx2  : acter le résultat
 *
 * Si le process meurt entre les deux, la demande reste CREATING : le job de
 * réconciliation (EC-06) la rattrape. Un état intermédiaire visible et
 * rattrapable vaut mieux qu'une transaction longue.
 */
@Injectable()
export class SendForSignatureService {
  private readonly log = new Logger(SendForSignatureService.name);

  constructor(
    @Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider,
    @Inject(DOCUMENT_RENDERER) private readonly renderer: DocumentRenderer,
    private readonly storage: ObjectStorage,
  ) {}

  async send(scope: Scope, contractId: string, dto: SendForSignatureDto, idempotencyKey: string, now: Date) {
    // --- Idempotence : rejeu de la même clé → on rend le résultat existant.
    // Le cas réel : timeout réseau, le client réessaie. Sans cela, le client
    // final reçoit DEUX invitations à signer le même contrat (§11.8).
    const existing = await withScope(scope, (tx) =>
      tx.signatureRequest.findUnique({ where: { idempotencyKey } }),
    );
    if (existing) {
      return { signatureRequestId: existing.id, status: existing.status };
    }

    // --- tx1 : valider et préparer -----------------------------------------
    const prepared = await withScope(scope, async (tx) => {
      const contract = await tx.contract.findUnique({
        where: { id: contractId },
        include: { customer: { select: { name: true } } },
      });
      // RLS a filtré : hors scope, la ligne n'existe pas pour cette session.
      if (!contract) throw new NotFoundException('Contrat introuvable');

      const hasLsi = dto.signers.some((s) => s.party === 'LSI');
      const hasClient = dto.signers.some((s) => s.party === 'CLIENT');
      if (!hasLsi || !hasClient) {
        // 422 : la requête est bien formée, mais viole une règle métier.
        throw new UnprocessableEntityException({
          code: 'CONTRACT_RULE_VIOLATION',
          rule: 'RM-12',
          detail: 'Un contrat doit avoir au moins un signataire côté LSI et un côté client.',
        });
      }

      // Le DOMAINE valide la transition (APPROVED + version cohérente).
      // On ne persiste PAS encore : le contrat ne bougera qu'après
      // acquittement du provider (EC-04).
      this.assertCanSend(contract);

      const version = await tx.contractVersion.findUnique({
        where: { id: contract.currentVersionId! },
      });
      if (!version) throw new UnprocessableEntityException('Aucune version à envoyer');

      // Les signataires sont créés maintenant : leurs id servent d'external_id
      // et doivent exister avant l'appel au provider (§11.3).
      await tx.contractSigner.deleteMany({ where: { contractId, status: 'PENDING' } });
      const signers = await Promise.all(
        dto.signers.map((s) =>
          tx.contractSigner.create({
            data: {
              id: uuidv7(),
              tenantId: scope.tenantId,
              customerId: contract.customerId,
              contractId,
              party: s.party,
              contactId: s.contactId ?? null,
              fullName: s.fullName,
              email: s.email,
              signingOrder: s.signingOrder,
              status: 'PENDING',
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      );

      let sigReq;
      try {
        sigReq = await tx.signatureRequest.create({
          data: {
            id: uuidv7(),
            tenantId: scope.tenantId,
            customerId: contract.customerId,
            contractId,
            versionId: version.id,
            provider: this.provider.name,
            status: 'CREATING',
            idempotencyKey,
            expireAt: this.expiry(now, dto.expireInDays),
            createdAt: now,
            updatedAt: now,
            createdByUserId: scope.userId,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') {
          // signature_requests_one_active (§8.5) : une seule demande active
          // par contrat. La contrainte est en base, pas dans un `if`.
          throw new ConflictException({
            code: 'SIGNATURE_ALREADY_IN_PROGRESS',
            detail: 'Une demande de signature est déjà en cours sur ce contrat.',
          });
        }
        throw e;
      }

      return { contract, version, signers, sigReq };
    });

    // --- I/O : HORS transaction --------------------------------------------
    const { contract, version, signers, sigReq } = prepared;

    const rendered = await this.renderer.render({
      html: version.bodyHtml,
      documentTitle: `${contract.reference} — ${contract.title}`,
    });

    // Le scope est dans le CHEMIN de stockage (§10.7) : politiques IAM et
    // inventaires en deviennent triviaux.
    const objectKey =
      `t/${scope.tenantId}/c/${contract.customerId}/contracts/${contractId}` +
      `/versions/${version.id}/draft.pdf`;
    await this.storage.put(objectKey, rendered.pdf, {
      tenantId: scope.tenantId,
      customerId: contract.customerId,
    });

    // Le hash est stocké AVANT l'envoi : c'est ce qui permet d'affirmer plus
    // tard « le document envoyé est exactement celui-ci » (§11.2).
    await withScope(scope, (tx) =>
      tx.contractVersion.update({
        where: { id: version.id },
        data: { pdfObjectKey: objectKey, pdfSha256: rendered.sha256 },
      }),
    );

    const submitters: SubmitterCommand[] = [...dto.signers]
      .sort((a, b) => a.signingOrder - b.signingOrder)
      .map((s) => {
        const row = signers.find((x) => x.email === s.email)!;
        return {
          party: s.party,
          externalId: row.id, // ← clé de rapprochement des webhooks (§11.5)
          fullName: s.fullName,
          email: s.email,
          signingOrder: s.signingOrder,
          requireEmail2fa: s.requireEmail2fa ?? s.party === 'CLIENT',
          fields: [
            { name: 'Référence', defaultValue: contract.reference, readonly: true },
            {
              name: 'Montant',
              defaultValue: this.formatAmount(contract.amountCents, contract.currency),
              readonly: true,
            },
          ],
        };
      });

    let submission;
    try {
      submission = await this.provider.createSubmission({
        pdf: rendered.pdf,
        documentName: `${contract.reference}.pdf`,
        order: 'preserved', // RM-13 : LSI d'abord, client ensuite
        expireAt: sigReq.expireAt!,
        subject: dto.subject ?? `Contrat ${contract.reference} — signature requise`,
        body: dto.body ?? 'Bonjour,\n\nVeuillez signer : {{submitter.link}}',
        // Construit côté serveur depuis une constante : jamais depuis une
        // entrée utilisateur, sinon open redirect (§11.7).
        completedRedirectUrl: `${process.env.PORTAL_URL ?? 'https://contrats.lsi-maintenance.fr'}/portal/signature-complete`,
        submitters,
        metadata: {
          tenant_id: scope.tenantId,
          customer_id: contract.customerId,
          contract_id: contractId,
          signature_request_id: sigReq.id,
        },
      });
    } catch (e) {
      // --- ÉCHEC : le contrat NE BOUGE PAS (EC-04) -------------------------
      //
      // On ne prétend jamais avoir envoyé ce qui n'est pas parti. Mais la
      // tentative est TRACÉE : un échec silencieux serait pire qu'un échec.
      const msg = e instanceof ProviderError ? e.message : (e as Error).message;
      this.log.error(`échec création submission contrat=${contractId} : ${msg}`);

      await withScope(scope, (tx) =>
        tx.signatureRequest.update({
          where: { id: sigReq.id },
          data: { status: 'FAILED', errorMessage: msg, updatedAt: new Date() },
        }),
      );

      throw new BadGatewayException({
        code: 'SIGNATURE_PROVIDER_ERROR',
        detail:
          'Le service de signature est indisponible. Le contrat reste approuvé, vous pouvez réessayer.',
        retryable: true,
      });
    }

    // --- tx2 : acter le succès ---------------------------------------------
    return withScope(scope, async (tx) => {
      await tx.signatureRequest.update({
        where: { id: sigReq.id },
        data: {
          status: 'SENT',
          providerSubmissionId: submission.providerSubmissionId,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      for (const s of submission.submitters) {
        if (!s.externalId) continue;
        await tx.contractSigner.update({
          where: { id: s.externalId },
          data: {
            status: 'SENT',
            providerSubmitterId: s.providerSubmitterId,
            providerSubmitterSlug: s.slug,
            updatedAt: new Date(),
          },
        });
      }

      // MAINTENANT seulement, le contrat bouge.
      const next = applyEvent(this.toSnapshot(contract), { type: 'SEND_FOR_SIGNATURE', actorUserId: scope.userId }, now);
      await tx.contract.update({
        where: { id: contractId },
        data: { status: next.status, updatedAt: now, updatedByUserId: scope.userId },
      });

      return { signatureRequestId: sigReq.id, status: 'SENT' as const };
    });
  }

  /** Valide la transition SANS la persister : le domaine décide, tôt. */
  private assertCanSend(contract: any): void {
    try {
      applyEvent(this.toSnapshot(contract), { type: 'SEND_FOR_SIGNATURE', actorUserId: 'check' }, new Date());
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        throw new ConflictException({
          code: e.code,
          detail: e.message,
          currentStatus: e.currentStatus,
          allowedTransitions: e.allowedTransitions,
        });
      }
      if (e instanceof BusinessRuleError) {
        throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
      }
      throw e;
    }
  }

  private toSnapshot(c: any) {
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
      // Les signataires sont vérifiés depuis le DTO en amont : à ce stade
      // ils viennent d'être créés.
      hasLsiSigner: true,
      hasClientSigner: true,
      hasRequiredAttachments: true,
      openAmendmentExists: false,
      hasSignedSuccessor: c.successorContractId !== null,
      signedAt: c.signedAt,
      activatedAt: c.activatedAt,
      terminatedAt: c.terminatedAt,
    };
  }

  private expiry(now: Date, days?: number): Date {
    const d = new Date(now);
    d.setDate(d.getDate() + (days ?? 30)); // évite les demandes zombies
    return d;
  }

  private formatAmount(cents: bigint | null, currency: string): string {
    if (cents === null) return '—';
    return `${(Number(cents) / 100).toFixed(2)} ${currency}`;
  }
}
