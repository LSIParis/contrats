import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { withScope, type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { sendFile } from '../common/http-io.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from './document-storage.port.js';
import { slugifyFilename } from './filename.js';

/** Libellés des pièces, pour l'interface et les noms de fichiers. */
export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  LEGACY_SCAN: 'Original importé',
  OCR_TEXT: 'Texte reconnu (OCR)',
  OCR_PDF: 'PDF interrogeable (OCR)',
  CONTRACT_PDF: 'PDF envoyé en signature',
  SIGNED_PDF: 'PDF signé',
  SIGNATURE_AUDIT_TRAIL: 'Dossier de preuve de signature',
  TERMINATION_LETTER: 'Courrier de résiliation',
  ATTACHMENT: 'Pièce jointe',
};

/**
 * Pièces d'un contrat (stored_documents) : originaux, OCR, PDF figé envoyé
 * en signature, PDF signé, dossier de preuve, courriers de résiliation.
 * Lecture seule ; la RLS borne au portefeuille (autre client → 404).
 */
@Controller('v1/contracts/:id/documents')
export class ContractDocumentsController {
  constructor(@Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage) {}

  @Get()
  async list(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.read');
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const docs = await tx.storedDocument.findMany({ where: { contractId: id }, orderBy: { createdAt: 'asc' } });
      return {
        items: docs.map((d) => ({
          id: d.id, kind: d.kind, label: DOCUMENT_KIND_LABELS[d.kind] ?? d.kind, origin: d.origin,
          filename: d.filename, contentType: d.contentType, sizeBytes: d.sizeBytes.toString(), sha256: d.sha256,
          derivedFromId: d.derivedFromId, createdAt: d.createdAt.toISOString(),
        })),
      };
    });
  }

  /** `?disposition=inline` pour un affichage dans l'application ; téléchargement par défaut. */
  @Get(':docId')
  async download(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string,
    @Query('disposition') disposition: string | undefined, @Res() res: FastifyReply,
  ) {
    assertCan(s, 'contracts.read');
    const doc = await withScope(scope, (tx) => tx.storedDocument.findFirst({ where: { id: docId, contractId: id } }));
    if (!doc) throw new NotFoundException('Pièce introuvable');
    const body = await this.storage.get(doc.objectKey, { tenantId: doc.tenantId, customerId: doc.customerId });
    if (!body) throw new NotFoundException('Pièce absente du stockage');
    sendFile(res, {
      body, contentType: doc.contentType, filename: slugifyFilename(doc.filename, 'document'),
      disposition: disposition === 'inline' ? 'inline' : 'attachment',
    });
  }
}
