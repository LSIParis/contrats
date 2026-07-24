import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { EDITABLE_STATUSES, type DocumentRenderer } from '@lsi/domain';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { DOCX_RENDERER } from '../documents/docx-renderer.port.js';
import type { DocxRenderer } from '../documents/docx-renderer.port.js';
import type { SaveContentDto } from './dto/save-content.dto.js';

@Injectable()
export class ContentService {
  constructor(
    @Inject(DOCUMENT_RENDERER) private readonly renderer: DocumentRenderer,
    @Inject(DOCX_RENDERER) private readonly docx: DocxRenderer,
  ) {}

  async saveContent(scope: Scope, id: string, dto: SaveContentDto) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        select: { id: true, tenantId: true, customerId: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const EDITABLE_OR_APPROVED = [...EDITABLE_STATUSES, 'APPROVED'] as const;
      if (!EDITABLE_OR_APPROVED.includes(c.status as (typeof EDITABLE_OR_APPROVED)[number])) {
        throw new ConflictException({
          code: 'RM-04',
          detail: 'Le contenu ne peut être édité que sur un brouillon, un contrat renvoyé, ou un contrat approuvé (qui repasse alors en brouillon).',
        });
      }

      const clean = sanitizeContractHtml(dto.bodyHtml);
      const max = await tx.contractVersion.aggregate({
        where: { contractId: id },
        _max: { versionNumber: true },
      });
      const versionNumber = (max._max.versionNumber ?? 0) + 1;
      const now = new Date();

      const version = await tx.contractVersion.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId: id,
          versionNumber, bodyHtml: clean, variables: {}, changeSummary: dto.changeSummary ?? null,
          createdAt: now, createdByUserId: scope.userId,
        },
        select: { id: true, versionNumber: true },
      });
      await tx.contract.update({
        where: { id },
        data: {
          currentVersionId: version.id,
          // RM-11 : éditer après validation invalide la validation.
          ...(c.status === 'APPROVED' ? { status: 'DRAFT', approvedVersionId: null } : {}),
          updatedAt: now, updatedByUserId: scope.userId,
        },
      });
      return version;
    });
  }

  async listVersions(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      // Le contrat doit être dans le scope, sinon 404 (RLS l'a déjà masqué).
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const items = await tx.contractVersion.findMany({
        where: { contractId: id },
        orderBy: { versionNumber: 'desc' },
        select: { id: true, versionNumber: true, changeSummary: true, createdAt: true },
      });
      return { items };
    });
  }

  async getVersion(scope: Scope, id: string, versionId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const v = await tx.contractVersion.findFirst({
        where: { id: versionId, contractId: id },
        select: { id: true, versionNumber: true, bodyHtml: true, createdAt: true },
      });
      if (!v) throw new NotFoundException('Version introuvable');
      return v;
    });
  }

  private async renderable(tx: any, id: string): Promise<{ html: string; title: string }> {
    const c = await tx.contract.findUnique({ where: { id }, select: { id: true, title: true, currentVersionId: true } });
    if (!c) throw new NotFoundException('Contrat introuvable');
    if (!c.currentVersionId) throw new UnprocessableEntityException('Aucune version à exporter');
    const version = await tx.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { bodyHtml: true } });
    if (!version) throw new UnprocessableEntityException('Version introuvable');
    return { html: version.bodyHtml, title: c.title };
  }

  /** Rendu PDF de la version courante — via Gotenberg (aperçu, non signé). */
  async previewPdf(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderable(tx, id);
      const rendered = await this.renderer.render({ html, documentTitle: title });
      return rendered.pdf;
    });
  }

  async exportDocx(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderable(tx, id);
      return this.docx.renderDocx(html, title);
    });
  }
}
