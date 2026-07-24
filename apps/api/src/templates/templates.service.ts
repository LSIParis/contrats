import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import type { DocumentRenderer } from '@lsi/domain';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { extractVariables, variablesSchemaOf } from './template-variables.js';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { DOCX_RENDERER, type DocxRenderer } from '../documents/docx-renderer.port.js';

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DOCUMENT_RENDERER) private readonly pdf: DocumentRenderer,
    @Inject(DOCX_RENDERER) private readonly docx: DocxRenderer,
  ) {}

  private async load(tx: any, id: string) {
    const t = await tx.contractTemplate.findUnique({
      where: { id },
      select: { id: true, tenantId: true, name: true, category: true, status: true, currentVersionId: true },
    });
    if (!t) throw new NotFoundException('Modèle introuvable');
    return t;
  }

  async list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.contractTemplate.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, category: true, status: true, currentVersionId: true, updatedAt: true, _count: { select: { versions: true } } },
      });
      return { items: rows.map((t: any) => ({ id: t.id, name: t.name, category: t.category, status: t.status, versionCount: t._count.versions, updatedAt: t.updatedAt })) };
    });
  }

  async get(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      const versions = await tx.contractTemplateVersion.findMany({
        where: { templateId: id }, orderBy: { versionNumber: 'asc' },
        select: { id: true, versionNumber: true, isImmutable: true, publishedAt: true, createdAt: true },
      });
      const cur = t.currentVersionId
        ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, versionNumber: true, bodyHtml: true, variablesSchema: true, isImmutable: true, publishedAt: true } })
        : null;
      return { id: t.id, name: t.name, category: t.category, status: t.status, currentVersion: cur, versions };
    });
  }

  async create(scope: Scope, name: string, category: string, now: Date) {
    return withScope(scope, async (tx) => {
      const id = uuidv7();
      const versionId = uuidv7();
      await tx.contractTemplate.create({ data: {
        id, tenantId: scope.tenantId, name, category: category as any, status: 'DRAFT',
        currentVersionId: versionId, createdAt: now, updatedAt: now,
      } });
      await tx.contractTemplateVersion.create({ data: {
        id: versionId, tenantId: scope.tenantId, templateId: id, versionNumber: 1,
        bodyHtml: '', variablesSchema: variablesSchemaOf([]), isImmutable: false, createdAt: now,
      } });
      return { id };
    });
  }

  async saveContent(scope: Scope, id: string, bodyHtml: string, now: Date, userId: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      const clean = sanitizeContractHtml(bodyHtml);
      const schema = variablesSchemaOf(extractVariables(clean));
      const cur = t.currentVersionId
        ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, versionNumber: true, isImmutable: true } })
        : null;
      let version;
      if (cur && !cur.isImmutable) {
        version = await tx.contractTemplateVersion.update({ where: { id: cur.id }, data: { bodyHtml: clean, variablesSchema: schema }, select: { id: true, versionNumber: true } });
      } else {
        const max = await tx.contractTemplateVersion.aggregate({ where: { templateId: id }, _max: { versionNumber: true } });
        version = await tx.contractTemplateVersion.create({ data: {
          id: uuidv7(), tenantId: t.tenantId, templateId: id, versionNumber: (max._max.versionNumber ?? 0) + 1,
          bodyHtml: clean, variablesSchema: schema, isImmutable: false, createdAt: now,
        }, select: { id: true, versionNumber: true } });
      }
      await tx.contractTemplate.update({ where: { id }, data: { currentVersionId: version.id, updatedAt: now, ...(t.status === 'PUBLISHED' ? { status: 'DRAFT' } : {}) } });
      return { versionId: version.id, versionNumber: version.versionNumber };
    });
  }

  async publish(scope: Scope, id: string, now: Date, userId: string) {
    return withScope(scope, async (tx) => {
      const t = await this.load(tx, id);
      if (t.status === 'DEPRECATED') throw new ConflictException({ code: 'DEPRECATED', detail: 'Un modèle déprécié ne peut pas être publié.' });
      if (!t.currentVersionId) throw new BadRequestException('Aucune version à publier.');
      const cur = await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { id: true, bodyHtml: true, isImmutable: true } });
      if (!cur) throw new BadRequestException('Aucune version à publier.');
      // Idempotent : re-publier un modèle déjà publié ne RÉÉCRIT PAS la
      // provenance (publishedAt/publishedByUserId) d'une version figée.
      if (t.status === 'PUBLISHED' && cur.isImmutable) return { ok: true as const };
      if (cur.bodyHtml.trim() === '') throw new BadRequestException('Corps vide : rien à publier.');
      await tx.contractTemplateVersion.update({ where: { id: cur.id }, data: { isImmutable: true, publishedAt: now, publishedByUserId: userId } });
      await tx.contractTemplate.update({ where: { id }, data: { status: 'PUBLISHED', updatedAt: now } });
      return { ok: true as const };
    });
  }

  async deprecate(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.load(tx, id);
      await tx.contractTemplate.update({ where: { id }, data: { status: 'DEPRECATED', updatedAt: now } });
      return { ok: true as const };
    });
  }

  private async renderableOf(tx: any, id: string): Promise<{ html: string; title: string }> {
    const t = await this.load(tx, id); // lève NotFound (404) hors scope — méthode privée existante
    const cur = t.currentVersionId
      ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { bodyHtml: true } })
      : null;
    const html = cur?.bodyHtml ?? '';
    if (html.trim() === '') throw new UnprocessableEntityException('Corps vide : rien à exporter.');
    return { html, title: t.name };
  }

  async exportPdf(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderableOf(tx, id);
      const rendered = await this.pdf.render({ html, documentTitle: title });
      return rendered.pdf;
    });
  }

  async exportDocx(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderableOf(tx, id);
      return this.docx.renderDocx(html, title);
    });
  }
}
