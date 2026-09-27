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
  hiddenTagHtml,
  initialsFooterHtml,
  documentFooterHtml,
  signatureBlockTags,
  signerRoleLabel,
} from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';
import type { SendForSignatureDto } from '../contracts/dto/send-for-signature.dto.js';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { SignatureAvailabilityService } from './signature-availability.service.js';

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
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly availability: SignatureAvailabilityService,
    private readonly config: TenantConfigService,
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

    // Signature électronique EFFECTIVE (drapeau du tenant + sonde DocuSeal) :
    // sinon 503 explicite, rien n'est créé (brief §7).
    await this.availability.assertEnabled(scope);
    const defaultOrder = await this.config.setting(scope, 'signature.defaultOrder');
    const signingOrder = dto.signingOrder ?? (defaultOrder === 'LSI_FIRST' ? 'LSI_THEN_CLIENT' : 'CLIENT_THEN_LSI');
    const delivery = dto.delivery ?? 'EMAIL';
    const expireInDays = dto.expireInDays ?? (await this.config.setting(scope, 'signature.expireDays'));

    // --- tx1 : valider et préparer -----------------------------------------
    const prepared = await withScope(scope, async (tx) => {
      const contract = await tx.contract.findUnique({
        where: { id: contractId },
        include: { customer: { select: { name: true } } },
      });
      // RLS a filtré : hors scope, la ligne n'existe pas pour cette session.
      if (!contract) throw new NotFoundException('Contrat introuvable');

      // Les signataires sont DÉFINIS sur le contrat (bloc Signataires) — on les
      // lit, on ne les redemande plus. Ordre = signingOrder (RM-13).
      const signers = await tx.contractSigner.findMany({
        where: { contractId },
        orderBy: { signingOrder: 'asc' },
      });
      const hasLsi = signers.some((s) => s.party === 'LSI');
      const hasClient = signers.some((s) => s.party === 'CLIENT');
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
            expireAt: this.expiry(now, expireInDays),
            mode: 'PDF',
            delivery,
            signingOrder,
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

    // Le corps du contrat ne porte AUCUN champ de signature. Sans balise, la
    // submission DocuSeal n'aurait rien à faire signer (découvert en testant
    // contre l'EE réelle). On annexe donc un bloc de signature avec une
    // balise de signature + date de signature par signataire (text-tags.ts)
    // — le rôle DOIT correspondre au roleLabel du submitter (§11.3).
    const withSignatureBlock = version.bodyHtml + this.buildSignatureBlock(signers);

    // Paraphe de chaque page, en pied de page (brief §7). ACTIVÉ PAR
    // DOCUSEAL_INITIALS_FOOTER=true, une fois validé contre l'instance réelle
    // par le test d'intégration : la balise y est reconstituée par Chromium
    // autour du numéro de page (06-docuseal.md §Gabarit).
    const roles = [...new Set(signers.map((s) => signerRoleLabel(s.party)))];
    const rendered = await this.renderer.render({
      html: withSignatureBlock,
      documentTitle: `${contract.reference} — ${contract.title}`,
      // Référence et pagination sur chaque page ; paraphes DocuSeal en plus si activés.
      footerHtml: documentFooterHtml(
        contract.reference,
        process.env.DOCUSEAL_INITIALS_FOOTER === 'true' ? initialsFooterHtml(roles) : '',
      ),
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
    await withScope(scope, async (tx) => {
      await tx.contractVersion.update({
        where: { id: version.id },
        data: { pdfObjectKey: objectKey, pdfSha256: rendered.sha256 },
      });
      await tx.signatureRequest.update({ where: { id: sigReq.id }, data: { sentPdfSha256: rendered.sha256 } });
      // Le PDF FIGÉ envoyé en signature rejoint le référentiel des documents
      // (écriture unique) : le PDF signé rapatrié en dérivera.
      await tx.storedDocument.createMany({
        data: [{
          id: uuidv7(), tenantId: scope.tenantId, customerId: contract.customerId, contractId,
          kind: 'CONTRACT_PDF', origin: 'GENERATED', objectKey, filename: `${contract.reference}.pdf`,
          contentType: 'application/pdf', sizeBytes: BigInt(rendered.pdf.length), sha256: rendered.sha256,
          uploadedByUserId: /^[0-9a-f-]{36}$/i.test(scope.userId) ? scope.userId : null, createdAt: now,
        }],
        skipDuplicates: true,
      });
    });

    const submitters: SubmitterCommand[] = [...signers]
      .sort((a, b) => a.signingOrder - b.signingOrder)
      .map((s) => ({
        party: s.party,
        roleLabel: signerRoleLabel(s.party), // même valeur que la balise du doc
        externalId: s.id, // ← clé de rapprochement des webhooks (§11.5)
        fullName: s.fullName,
        email: s.email,
        signingOrder: s.signingOrder,
        requireEmail2fa: s.party === 'CLIENT', // défaut : 2FA côté client
        // AUCUN champ pré-rempli.
        //
        // DocuSeal rejette (422 « Unknown field ») tout champ de
        // submitters[].fields qui n'existe pas dans le document — découvert
        // contre l'EE réelle. Et c'était de toute façon redondant : la
        // référence et le montant sont IMPRIMÉS dans le corps du contrat
        // (donc déjà immuables et visibles). Les redoubler en champs
        // DocuSeal n'ajoutait rien. Le seul champ interactif est la
        // signature, qui vient de la balise {{Signature;...}} du document.
        fields: [],
      }));

    let submission;
    try {
      submission = await this.provider.createSubmission({
        pdf: rendered.pdf,
        // L'adaptateur revérifie : le PDF envoyé est celui dont l'empreinte
        // vient d'être stockée sur la version (§11.2).
        pdfSha256: rendered.sha256,
        documentName: `${contract.reference}.pdf`,
        // Ordre : paramètre du tenant (client puis LSI par défaut) ou choix à l'envoi.
        signingOrder,
        delivery,
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

      // MAINTENANT seulement, le contrat bouge — via la machine (journal des transitions).
      const event = { type: 'SEND_FOR_SIGNATURE', actorUserId: scope.userId } as const;
      const next = applyEvent(toContractSnapshot(contract), event, now);
      await persistTransition(tx, contractId, event, next, now, scope.userId);

      return { signatureRequestId: sigReq.id, status: 'SENT' as const };
    });
  }

  /** Valide la transition SANS la persister : le domaine décide, tôt. */
  private assertCanSend(contract: any): void {
    try {
      applyEvent(toContractSnapshot(contract), { type: 'SEND_FOR_SIGNATURE', actorUserId: 'check' }, new Date());
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

  /**
   * Bloc de signature annexé au document, balises DocuSeal par signataire.
   *
   * Signature + date de signature (`datenow`, non modifiable) : DocuSeal
   * parse ces balises du texte du PDF et les transforme en champs attribués
   * au bon rôle. Le libellé de rôle vient de `signerRoleLabel` — la MÊME
   * source que le `roleLabel` du submitter. Balises en texte blanc : le PDF
   * figé reste lisible (06-docuseal.md §Gabarit).
   */
  private buildSignatureBlock(signers: readonly { party: 'LSI' | 'CLIENT'; fullName: string }[]): string {
    const rows = [...signers]
      .sort((a, b) => (a.party === 'LSI' ? -1 : 1) - (b.party === 'LSI' ? -1 : 1))
      .map((s) => {
        const role = signerRoleLabel(s.party);
        const tags = signatureBlockTags(role);
        const who = s.party === 'LSI' ? 'Pour LSI Maintenance' : 'Pour le client';
        return `<td style="width:50%;vertical-align:top;padding:8px;">
  <div style="font-weight:bold;">${who}</div>
  <div>${escapeHtml(s.fullName)}</div>
  <div style="margin-top:12px;">Signature :</div>
  <div style="height:64px;">${hiddenTagHtml(tags.signature)}</div>
  <div style="margin-top:8px;">Date de signature : ${hiddenTagHtml(tags.date)}</div>
</td>`;
      })
      .join('\n');

    return `<div style="margin-top:40px;page-break-inside:avoid;">
  <h2 style="font-size:13pt;">Signatures</h2>
  <table style="width:100%;border-collapse:collapse;"><tr>${rows}</tr></table>
</div>`;
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

/** Le nom d'un signataire est du texte utilisateur : on l'échappe (§13.3). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
