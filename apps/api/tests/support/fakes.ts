import { createHash } from 'node:crypto';
import type {
  CreateSubmissionCommand,
  DocumentRenderer,
  ESignatureProvider,
  ProviderSubmission,
  RenderRequest,
  RenderedDocument,
} from '@lsi/domain';
import { ProviderError } from '@lsi/domain';
import type { DocxRenderer } from '../../src/documents/docx-renderer.port.js';

/**
 * Provider contrôlable, pour tester la LOGIQUE d'envoi.
 *
 * Il n'est PAS un simulateur DocuSeal : la conformité du payload réel est
 * testée séparément, dans le test de l'adaptateur. Ici on vérifie les
 * transitions, l'idempotence et EC-04 — des choses que le vrai DocuSeal
 * ne saurait pas nous faire reproduire à la demande (comme tomber en panne
 * exactement une fois).
 */
export class FakeProvider implements ESignatureProvider {
  readonly name = 'DOCUSEAL' as const;

  readonly calls: CreateSubmissionCommand[] = [];
  readonly reminded: string[] = [];
  readonly revoked: string[] = [];
  private failure: string | null = null;
  private counter = 0;
  private readonly created = new Map<string, ProviderSubmission>();

  reset(): void {
    this.calls.length = 0;
    this.reminded.length = 0;
    this.revoked.length = 0;
    this.failure = null;
    this.created.clear();
  }

  /** Fait échouer le PROCHAIN appel — et lui seul. */
  failNext(message: string): void {
    this.failure = message;
  }

  async createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission> {
    if (this.failure) {
      const msg = this.failure;
      this.failure = null;
      throw new ProviderError(msg, true);
    }

    this.calls.push(cmd);
    const id = String(++this.counter + 900_000);
    const submission: ProviderSubmission = {
      providerSubmissionId: id,
      submitters: cmd.submitters.map((s, i) => ({
        externalId: s.externalId,
        providerSubmitterId: `${id}-${i}`,
        slug: `slug${id}${i}`,
      })),
    };
    this.created.set(cmd.metadata.signature_request_id ?? id, submission);
    return submission;
  }

  async findSubmissionByExternalId(externalId: string): Promise<ProviderSubmission | null> {
    return this.created.get(externalId) ?? null;
  }

  async remindSubmitter(providerSubmitterId: string): Promise<void> {
    if (this.failure) {
      const msg = this.failure;
      this.failure = null;
      throw new ProviderError(msg, true);
    }
    this.reminded.push(providerSubmitterId);
  }

  async revokeSubmission(providerSubmissionId: string): Promise<void> {
    if (this.failure) {
      const msg = this.failure;
      this.failure = null;
      throw new ProviderError(msg, true);
    }
    this.revoked.push(providerSubmissionId);
  }

  async downloadSignedDocuments(providerSubmissionId: string): Promise<{ signedPdf: Buffer; auditTrail: Buffer | null }> {
    return {
      signedPdf: Buffer.from(`%PDF-1.7 signed ${providerSubmissionId}\n%%EOF`, 'utf8'),
      auditTrail: Buffer.from(`%PDF-1.7 audit ${providerSubmissionId}\n%%EOF`, 'utf8'),
    };
  }

  verifyWebhook() {
    return { valid: true };
  }

  parseWebhook() {
    return null;
  }
}

/**
 * Rendu documentaire déterministe.
 *
 * Le vrai rendu passe par Gotenberg (Chromium en conteneur) : le tester ici
 * mesurerait Chromium, pas notre logique. L'adaptateur Gotenberg exige un
 * test d'intégration à part — et il n'existe pas encore.
 */
export class FakeRenderer implements DocumentRenderer {
  /** Dernier HTML reçu — permet de vérifier l'injection du bloc de signature. */
  lastHtml = '';

  async render(req: RenderRequest): Promise<RenderedDocument> {
    this.lastHtml = req.html;
    // Un PDF minimal mais réel : commence par %PDF-, donc reconnaissable.
    const pdf = Buffer.from(`%PDF-1.7\n% ${req.documentTitle}\n${req.html}\n%%EOF`, 'utf8');
    return { pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
  }
}

/** Rendu DOCX déterministe : un Buffer reconnaissable (préfixe ZIP PK). */
export class FakeDocxRenderer implements DocxRenderer {
  lastHtml = '';
  async renderDocx(html: string, title: string): Promise<Buffer> {
    this.lastHtml = html;
    return Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from(`\n${title}\n${html}`, 'utf8')]);
  }
}
