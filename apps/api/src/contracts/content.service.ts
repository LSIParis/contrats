import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { EDITABLE_STATUSES } from '@lsi/domain';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import type { SaveContentDto } from './dto/save-content.dto.js';

@Injectable()
export class ContentService {
  async saveContent(scope: Scope, id: string, dto: SaveContentDto) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id },
        select: { id: true, tenantId: true, customerId: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({
          code: 'RM-04',
          detail: 'Le contenu ne peut être édité que sur un brouillon ou un contrat renvoyé pour modification.',
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
        data: { currentVersionId: version.id, updatedAt: now, updatedByUserId: scope.userId },
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
}
