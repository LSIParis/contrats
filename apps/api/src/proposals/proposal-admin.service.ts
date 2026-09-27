import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { appendAudit, uuidv7, withScope, type Scope } from '@lsi/persistence';
import { listPendingValidations, type PendingValidation } from '@lsi/pricing';
import { sha256Hex } from './proposal-content.js';
import { templateDefinition } from './pricing-definition.js';
import { actorOf } from './proposals.service.js';

/**
 * Administration du module (brief §12.9 « admin gère modèles, bibliothèque,
 * seuils et CGV ») et écran « Prix à valider » (annexe C, règle 7).
 *
 * Toute modification faite ICI d'un modèle ou d'un contenu de bibliothèque
 * pose `userModifiedAt` : le seed de l'annexe C ne réécrira plus jamais cet
 * élément (sauf `--force`, qui restaure la version du fichier). Valider un
 * prix est une action d'administrateur, tracée dans le journal d'audit.
 */
@Injectable()
export class ProposalAdminService {
  // -------------------------------------------------------------------------
  // Modèles
  // -------------------------------------------------------------------------

  async templates(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.proposalTemplate.findMany({ orderBy: { name: 'asc' }, include: { lines: true, sections: true } });
      return {
        items: rows.map((t: any) => ({
          id: t.id, slug: t.slug, name: t.name, description: t.description, acceptanceMode: t.acceptanceMode,
          contractTemplateSlug: t.contractTemplateSlug, signedProposalIsContract: t.signedProposalIsContract,
          seedVersion: t.seedVersion, userModifiedAt: t.userModifiedAt, archivedAt: t.archivedAt,
          pendingValidations: listPendingValidations(templateDefinition(t), t.sections).length,
        })),
      };
    });
  }

  async template(scope: Scope, slug: string) {
    return withScope(scope, async (tx) => {
      const t = await this.templateOrThrow(tx, scope, slug);
      return {
        ...t,
        definition: templateDefinition(t),
        sections: [...t.sections].sort((a: any, b: any) => a.position - b.position),
        pendingValidations: listPendingValidations(templateDefinition(t), t.sections),
      };
    });
  }

  private async templateOrThrow(tx: any, scope: Scope, slug: string) {
    const t = await tx.proposalTemplate.findUnique({
      where: { tenantId_slug: { tenantId: scope.tenantId, slug } },
      include: { lines: { orderBy: { position: 'asc' } }, sections: { orderBy: { position: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Modèle introuvable');
    return t;
  }

  async updateTemplate(scope: Scope, slug: string, body: Record<string, unknown>, now: Date) {
    const t = await withScope(scope, async (tx) => {
      const t0 = await this.templateOrThrow(tx, scope, slug);
      await tx.proposalTemplate.update({ where: { id: t0.id }, data: { ...body, userModifiedAt: now, updatedAt: now } });
      return t0;
    });
    await this.audit(scope, 'proposal_template.update', t.id, { slug, changes: body }, now);
    return this.template(scope, slug);
  }

  async updateLine(scope: Scope, slug: string, key: string, body: { label?: string | undefined; pricing?: unknown; priceSource?: string | undefined }, now: Date) {
    const before = await withScope(scope, async (tx) => {
      const t = await this.templateOrThrow(tx, scope, slug);
      const line = t.lines.find((l: any) => l.key === key);
      if (!line) throw new NotFoundException('Ligne introuvable');
      if (body.pricing && 'dependsOn' in (body.pricing as object)) {
        const p = body.pricing as { dependsOn: string; byChoice: Record<string, number> };
        const choice = (t.pricingChoices as any[]).find((c) => c.key === p.dependsOn);
        const expected = choice?.options.map((o: any) => o.value).sort().join(',');
        if (!choice || expected !== Object.keys(p.byChoice).sort().join(',')) {
          throw new BadRequestException('byChoice doit couvrir exactement les valeurs du choix.');
        }
      }
      // Un prix MODIFIÉ repasse « à valider » : il n'est plus celui d'une offre validée.
      const pricingChanged = body.pricing !== undefined && JSON.stringify(body.pricing) !== JSON.stringify(line.pricing);
      await tx.proposalTemplatePricingLine.update({
        where: { id: line.id },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.priceSource !== undefined ? { priceSource: body.priceSource } : {}),
          ...(body.pricing !== undefined ? { pricing: body.pricing as object } : {}),
          ...(pricingChanged ? { priceStatus: 'TO_VALIDATE', priceStatusByChoice: undefined } : {}),
        },
      });
      await tx.proposalTemplate.update({ where: { id: t.id }, data: { userModifiedAt: now, updatedAt: now } });
      return { id: t.id, line };
    });
    await this.audit(scope, 'proposal_template.line_update', before.id, { slug, key, before: { label: before.line.label, pricing: before.line.pricing }, after: body }, now);
    return this.template(scope, slug);
  }

  // -------------------------------------------------------------------------
  // Prix à valider (annexe C, règle 7)
  // -------------------------------------------------------------------------

  async pending(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.proposalTemplate.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' }, include: { lines: true, sections: true } });
      const items: (PendingValidation & { templateSlug: string; templateName: string; detail: unknown })[] = [];
      for (const t of rows) {
        const def = templateDefinition(t);
        for (const p of listPendingValidations(def, t.sections)) {
          const line = p.scope === 'LINE' ? def.lines.find((l) => l.key === p.key) : undefined;
          const rule = p.scope === 'RULE' ? def.rules.find((r) => r.key === p.key) : undefined;
          items.push({
            ...p,
            templateSlug: t.slug,
            templateName: t.name,
            detail: line
              ? { unit: line.unit, pricing: line.pricing, priceSource: line.priceSource ?? null }
              : rule && 'amountCents' in rule
                ? { amountCents: rule.amountCents, priceSource: rule.priceSource ?? null }
                : rule && 'percent' in rule
                  ? { percent: rule.percent }
                  : null,
          });
        }
      }
      return { items, total: items.length };
    });
  }

  async validate(scope: Scope, body: { templateSlug: string; scope: 'LINE' | 'RULE' | 'SECTION' | 'CHOICE'; key: string; choiceValue?: string | undefined }, now: Date) {
    const result = await withScope(scope, async (tx) => {
      const t = await this.templateOrThrow(tx, scope, body.templateSlug);
      switch (body.scope) {
        case 'LINE': {
          const line = t.lines.find((l: any) => l.key === body.key);
          if (!line) throw new NotFoundException('Ligne introuvable');
          if (line.priceStatusByChoice) {
            const byChoice = { ...(line.priceStatusByChoice as Record<string, string>) };
            if (!body.choiceValue || byChoice[body.choiceValue] !== 'TO_VALIDATE') throw new ConflictException({ code: 'NOT_PENDING', detail: 'Rien à valider pour ce choix.' });
            byChoice[body.choiceValue] = 'VALIDATED';
            const all = Object.values(byChoice).every((s) => s === 'VALIDATED');
            await tx.proposalTemplatePricingLine.update({ where: { id: line.id }, data: { priceStatusByChoice: byChoice, ...(all ? { priceStatus: 'VALIDATED' } : {}) } });
          } else {
            if (line.priceStatus !== 'TO_VALIDATE') throw new ConflictException({ code: 'NOT_PENDING', detail: 'Ce prix est déjà validé.' });
            await tx.proposalTemplatePricingLine.update({ where: { id: line.id }, data: { priceStatus: 'VALIDATED' } });
          }
          break;
        }
        case 'RULE': {
          const rules = t.pricingRules as any[];
          const r = rules.find((x) => x.key === body.key);
          if (!r || r.priceStatus !== 'TO_VALIDATE') throw new ConflictException({ code: 'NOT_PENDING', detail: 'Rien à valider pour cette règle.' });
          await tx.proposalTemplate.update({ where: { id: t.id }, data: { pricingRules: rules.map((x) => (x.key === body.key ? { ...x, priceStatus: 'VALIDATED' } : x)) } });
          break;
        }
        case 'SECTION': {
          const n = await tx.proposalTemplateSection.updateMany({ where: { templateId: t.id, key: body.key, validationStatus: 'TO_VALIDATE' }, data: { validationStatus: 'VALIDATED' } });
          if (n.count === 0) throw new ConflictException({ code: 'NOT_PENDING', detail: 'Rien à valider pour cette section.' });
          break;
        }
        case 'CHOICE': {
          const choices = t.pricingChoices as any[];
          const c = choices.find((x) => x.key === body.key);
          if (!c || c.priceStatus !== 'TO_VALIDATE') throw new ConflictException({ code: 'NOT_PENDING', detail: 'Rien à valider pour ce choix.' });
          await tx.proposalTemplate.update({ where: { id: t.id }, data: { pricingChoices: choices.map((x) => (x.key === body.key ? { ...x, priceStatus: 'VALIDATED' } : x)) } });
          break;
        }
      }
      // Validé dans l'interface : le modèle devient propre au tenant (le seed ne l'écrase plus).
      await tx.proposalTemplate.update({ where: { id: t.id }, data: { userModifiedAt: now, updatedAt: now } });
      return t.id;
    });
    await this.audit(scope, 'proposal_template.price_validated', result, body, now);
    return this.pending(scope);
  }

  // -------------------------------------------------------------------------
  // Bibliothèque de contenus
  // -------------------------------------------------------------------------

  async library(scope: Scope) {
    return withScope(scope, async (tx) => ({
      items: await tx.contentLibraryItem.findMany({ where: { archivedAt: null }, orderBy: [{ folder: 'asc' }, { title: 'asc' }] }),
    }));
  }

  async createLibraryItem(scope: Scope, body: { key: string; title: string; folder: string; body: string; requiresLegalReview?: boolean | undefined }, now: Date) {
    const created = await withScope(scope, async (tx) => {
      const r = await tx.contentLibraryItem.createMany({
        data: [{
          id: uuidv7(), tenantId: scope.tenantId, key: body.key, title: body.title, folder: body.folder, body: body.body,
          requiresLegalReview: body.requiresLegalReview ?? false, userModifiedAt: now, createdAt: now, updatedAt: now,
        }],
        skipDuplicates: true,
      });
      if (r.count === 0) throw new ConflictException({ code: 'LIBRARY_KEY_EXISTS', detail: `La clé ${body.key} existe déjà.` });
      return tx.contentLibraryItem.findUniqueOrThrow({ where: { tenantId_key: { tenantId: scope.tenantId, key: body.key } } });
    });
    await this.audit(scope, 'content_library.create', created.id, { key: body.key }, now);
    return created;
  }

  async updateLibraryItem(scope: Scope, key: string, body: Record<string, unknown>, now: Date) {
    const updated = await withScope(scope, async (tx) => {
      const item = await tx.contentLibraryItem.findUnique({ where: { tenantId_key: { tenantId: scope.tenantId, key } } });
      if (!item) throw new NotFoundException('Contenu introuvable');
      return tx.contentLibraryItem.update({
        where: { id: item.id },
        // Nouvelle version du contenu ; les propositions envoyées gardent le texte figé.
        data: { ...body, version: { increment: 1 }, userModifiedAt: now, updatedAt: now },
      });
    });
    await this.audit(scope, 'content_library.update', updated.id, { key, version: updated.version, sha256: sha256Hex(updated.body) }, now);
    return updated;
  }

  // -------------------------------------------------------------------------
  // CGV versionnées
  // -------------------------------------------------------------------------

  async terms(scope: Scope) {
    return withScope(scope, async (tx) => ({
      items: await tx.proposalTerms.findMany({ orderBy: { versionNumber: 'desc' }, select: { id: true, versionNumber: true, title: true, sha256: true, createdAt: true } }),
    }));
  }

  async publishTerms(scope: Scope, body: { title: string; body: string }, now: Date) {
    const row = await withScope(scope, async (tx) => {
      const last = await tx.proposalTerms.findFirst({ where: { tenantId: scope.tenantId }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } });
      return tx.proposalTerms.create({
        data: {
          id: uuidv7(), tenantId: scope.tenantId, versionNumber: (last?.versionNumber ?? 0) + 1, title: body.title, body: body.body,
          sha256: sha256Hex(body.body), createdByUserId: actorOf(scope), createdAt: now,
        },
      });
    });
    await this.audit(scope, 'proposal_terms.publish', row.id, { versionNumber: row.versionNumber, sha256: row.sha256 }, now);
    return row;
  }

  /** Correspondance modèle de proposition → contrat type (`contract_templates.slug`, V2-H47). */
  async setContractTemplateSlug(scope: Scope, contractTemplateId: string, slug: string | null, now: Date) {
    await withScope(scope, async (tx) => {
      const ct = await tx.contractTemplate.findUnique({ where: { id: contractTemplateId } });
      if (!ct) throw new NotFoundException('Contrat type introuvable');
      if (slug) {
        const taken = await tx.contractTemplate.findFirst({ where: { slug, id: { not: contractTemplateId } }, select: { id: true } });
        if (taken) throw new ConflictException({ code: 'SLUG_TAKEN', detail: `Le slug ${slug} est déjà utilisé.` });
      }
      await tx.contractTemplate.update({ where: { id: contractTemplateId }, data: { slug, updatedAt: now } });
    });
    await this.audit(scope, 'contract_template.slug', contractTemplateId, { slug }, now);
    return { id: contractTemplateId, slug };
  }

  private async audit(scope: Scope, action: string, resourceId: string | null, after: unknown, now: Date) {
    await appendAudit({
      tenantId: scope.tenantId, customerId: null, actorUserId: actorOf(scope), actorKind: scope.actorKind, actorIp: null,
      actorUserAgent: null, action, resourceType: action.split('.')[0] ?? 'proposal_template', resourceId, after, requestId: null, occurredAt: now,
    });
  }
}
