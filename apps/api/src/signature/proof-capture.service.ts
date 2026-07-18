import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { withScope, type Scope } from '@lsi/persistence';
import type { ESignatureProvider } from '@lsi/domain';
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
    const docs = await this.provider.downloadSignedDocuments(sr.providerSubmissionId);
    const objScope = { tenantId: sr.tenantId, customerId: sr.customerId };
    const prefix = `t/${sr.tenantId}/c/${sr.customerId}/contracts/${sr.contractId}/signed/${sr.id}`;

    const signedKey = `${prefix}/document.pdf`;
    const signedHash = sha256(docs.signedPdf);
    await this.storage.put(signedKey, docs.signedPdf, objScope, 'application/pdf');

    let auditKey: string | null = null;
    let auditHash: string | null = null;
    if (docs.auditTrail) {
      auditKey = `${prefix}/audit-trail.pdf`;
      auditHash = sha256(docs.auditTrail);
      await this.storage.put(auditKey, docs.auditTrail, objScope, 'application/pdf');
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

    this.log.log(`preuves capturées pour signature_request=${signatureRequestId} (sha=${signedHash.slice(0, 12)}…)`);
    // audit_log est écrit par l'appelant, qui connaît l'acteur.
    void auditHash; // conservé pour un futur dossier de preuve détaillé
    return true;
  }
}
