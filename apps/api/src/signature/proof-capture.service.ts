import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { withScope, type Scope } from '@lsi/persistence';
import { linkDocumentHashes, type DocumentHashLink, type ESignatureProvider } from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * Capture des preuves de signature. (§11.6, W-05)
 *
 * Dès qu'un contrat est signé, on rapatrie le PDF signé + la piste d'audit
 * depuis le provider, on les hashe, on les stocke chez NOUS, et on enregistre
 * les clés et empreintes. On ne dépend plus jamais du provider pour produire
 * une preuve.
 *
 * IDEMPOTENT : si l'empreinte est déjà là, on ne refait rien. C'est essentiel
 * car cette capture peut être déclenchée deux fois (webhook + réconciliation
 * EC-06).
 */
@Injectable()
export class ProofCaptureService {
  private readonly log = new Logger(ProofCaptureService.name);

  constructor(
    @Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  /**
   * Capture les preuves d'une signature_request complétée.
   * Renvoie true si une capture a eu lieu, false si rien à faire.
   */
  async capture(scope: Scope, signatureRequestId: string, now: Date): Promise<boolean> {
    // Étape 1 : charger et décider (dans le scope, RLS active).
    const sr = await withScope(scope, (tx) =>
      tx.signatureRequest.findUnique({ where: { id: signatureRequestId } }),
    );
    if (!sr) return false;
    if (sr.status !== 'COMPLETED') return false; // pas encore tout signé
    if (sr.signedPdfObjectKey) return false; // déjà capturé (idempotent)
    if (!sr.providerSubmissionId) return false;

    // Étape 2 : téléchargement + stockage — I/O réseau, HORS transaction.
    // Tout en OCTETS : le PDF fusionné (documents?merge=true) fait foi comme
    // « document signé », le journal d'audit l'accompagne. Aucune URL du
    // provider n'est conservée.
    const docs = await this.provider.downloadCompletedDocuments(sr.providerSubmissionId);
    const objScope = { tenantId: sr.tenantId, customerId: sr.customerId };
    const prefix = `t/${sr.tenantId}/c/${sr.customerId}/contracts/${sr.contractId}/signed/${sr.id}`;

    const signedKey = `${prefix}/document.pdf`;
    const signedHash = sha256(docs.mergedPdf);
    await this.storage.put(signedKey, docs.mergedPdf, objScope, 'application/pdf');

    let auditKey: string | null = null;
    let auditHash: string | null = null;
    if (docs.auditLogPdf) {
      auditKey = `${prefix}/audit-trail.pdf`;
      auditHash = sha256(docs.auditLogPdf);
      await this.storage.put(auditKey, docs.auditLogPdf, objScope, 'application/pdf');
    }

    // Lien d'empreintes envoyé ↔ signé (06-docuseal.md §Empreintes). DocuSeal
    // réécrit le PDF (champs dessinés, balises retirées, scellement) : les
    // empreintes diffèrent, on conserve les deux et leur relation.
    const version = await withScope(scope, (tx) =>
      tx.contractVersion.findUnique({ where: { id: sr.versionId }, select: { pdfSha256: true } }),
    );
    let link: DocumentHashLink | null = null;
    try {
      link = version?.pdfSha256 ? linkDocumentHashes(version.pdfSha256, signedHash) : null;
    } catch (e) {
      // Empreinte envoyée malformée : on n'invente pas de lien, mais on ne
      // bloque pas la capture — les octets signés sont déjà en sûreté.
      this.log.error(`empreinte envoyée inexploitable (version ${sr.versionId}) : ${(e as Error).message}`);
    }

    // Étape 3 : enregistrer les preuves (dans le scope).
    await withScope(scope, (tx) =>
      tx.signatureRequest.update({
        where: { id: signatureRequestId },
        data: {
          signedPdfObjectKey: signedKey,
          signedPdfSha256: signedHash,
          auditTrailObjectKey: auditKey,
          updatedAt: now,
        },
      }),
    );

    this.log.log(
      `preuves capturées pour signature_request=${signatureRequestId} ` +
        `(signé=${signedHash.slice(0, 12)}…, envoyé=${link?.sentSha256.slice(0, 12) ?? '∅'}…, ` +
        `relation=${link?.relation ?? 'INCONNUE'}, audit=${auditHash?.slice(0, 12) ?? '∅'})`,
    );
    // audit_log est écrit par l'appelant, qui connaît l'acteur.
    // TODO(schéma) : persister `link` (sentSha256, relation) et auditHash
    // quand les colonnes existeront (06-docuseal.md §Empreintes) — la
    // migration relève du lot schéma, pas de cet adaptateur.
    return true;
  }
}
