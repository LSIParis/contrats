import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import {
  applyEvent, BusinessRuleError, composeContractBody, diffClauses, extractVariables, InvalidTransitionError,
  renderVariables, validateVariables, VARIABLE_REGISTRY,
  type ContractEvent, type VariableType,
} from '@lsi/domain';
import { z } from 'zod';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';

/**
 * Contenu STRUCTURÉ d'un contrat : clauses, annexes, variables (lot 2).
 * Spécification : docs/contrats/01-domaine.md §6.
 *
 * Chaque enregistrement crée une NOUVELLE version (immuable) portant ses
 * clauses et annexes, et le document composé (`body_html`) — celui qui est
 * prévisualisé, rendu en PDF figé et signé. Un modèle mis à jour ne modifie
 * JAMAIS un contrat émis : les clauses sont COPIÉES à la création.
 */

const CATEGORY = z.enum([
  'OBJET', 'DUREE', 'PRIX', 'SLA', 'RESPONSABILITE', 'RGPD', 'CONFIDENTIALITE',
  'PROPRIETE_INTELLECTUELLE', 'ASSURANCE', 'RESILIATION', 'DIVERS',
]);

export const SaveStructureSchema = z
  .object({
    clauses: z
      .array(
        z
          .object({
            clauseKey: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/).optional(),
            title: z.string().trim().min(1).max(200),
            category: CATEGORY,
            bodyHtml: z.string().max(100_000),
            origin: z.enum(['TEMPLATE', 'LIBRARY', 'CUSTOM', 'AI']).default('CUSTOM'),
            sourceClauseVersionId: z.uuid().nullable().optional(),
            /**
             * Métadonnées d'une clause IA reprise d'une suggestion (risque,
             * justification, sources). Ignorées hors origine AI ; pour une
             * clause IA déjà présente (même clauseKey), celles de la version
             * précédente sont conservées si ce champ est absent.
             */
            ai: z
              .object({
                risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
                justification: z.string().trim().max(5_000),
                sources: z.array(z.object({ url: z.url().max(2048), title: z.string().max(500) }).strict()).max(50).default([]),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    annexes: z
      .array(
        z
          .object({
            kind: z.enum(['SLA', 'ASSETS', 'PRICING_GRID', 'DPA_ART28', 'OTHER']),
            title: z.string().trim().min(1).max(200),
            bodyHtml: z.string().max(200_000).nullable().optional(),
            data: z.record(z.string(), z.unknown()).nullable().optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    variables: z.record(z.string(), z.unknown()).default({}),
    changeSummary: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => new Set(v.clauses.map((c) => c.clauseKey).filter(Boolean)).size === v.clauses.filter((c) => c.clauseKey).length, {
    message: 'clauseKey en double',
    path: ['clauses'],
  });
export type SaveStructure = z.infer<typeof SaveStructureSchema>;

export const ReviewClauseSchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().trim().max(2000).optional() })
  .strict();

/** Fournisseur de la grille tarifaire rendue (lot 3). Absent : annexe signalée « à générer ». */
export const PRICING_GRID_RENDERER = Symbol('PRICING_GRID_RENDERER');
export interface PricingGridRenderer {
  renderGrid(tx: unknown, contractId: string, at: Date): Promise<string | null>;
}

interface ClauseInput {
  clauseKey: string;
  title: string;
  category: string;
  bodyHtml: string;
  origin: string;
  sourceClauseVersionId: string | null;
  aiRisk?: string | null;
  aiJustification?: string | null;
  aiSources?: unknown;
}

@Injectable()
export class StructureService {
  constructor(@Optional() @Inject(PRICING_GRID_RENDERER) private readonly pricingGrid?: PricingGridRenderer) {}

  // -------------------------------------------------------------------------
  // Création depuis un modèle
  // -------------------------------------------------------------------------

  /**
   * Version 1 d'un contrat créé depuis une version PUBLIÉE de modèle : clauses
   * épinglées copiées, annexes par défaut, variables pré-remplies depuis le
   * client, le prestataire et le contrat. Appelé dans la transaction de création.
   */
  async initializeFromTemplate(tx: any, contractId: string, templateVersionId: string, versionId: string, now: Date, userId: string) {
    const tv = await tx.contractTemplateVersion.findUnique({
      where: { id: templateVersionId },
      include: { clauses: { orderBy: { position: 'asc' }, include: { clauseVersion: { include: { item: true } } } } },
    });
    if (!tv) throw new NotFoundException('Version de modèle introuvable');
    if (!tv.isImmutable) {
      throw new ConflictException({ code: 'TEMPLATE_NOT_PUBLISHED', detail: 'Seule une version PUBLIÉE de modèle peut servir de base à un contrat.' });
    }

    const clauses: ClauseInput[] = tv.clauses.length
      ? tv.clauses.map((tc: any) => ({
          clauseKey: tc.clauseVersion.item.code,
          title: tc.clauseVersion.item.title,
          category: tc.clauseVersion.item.category,
          bodyHtml: tc.clauseVersion.bodyHtml,
          origin: 'TEMPLATE',
          sourceClauseVersionId: tc.clauseVersion.id,
        }))
      : // Modèle historique non structuré : son corps devient une clause unique.
        tv.bodyHtml.trim()
        ? [{ clauseKey: 'CORPS', title: 'Conditions', category: 'DIVERS', bodyHtml: tv.bodyHtml, origin: 'TEMPLATE', sourceClauseVersionId: null }]
        : [];
    const annexes = (Array.isArray(tv.defaultAnnexes) ? tv.defaultAnnexes : []) as { kind: string; title: string; bodyHtml?: string | null }[];
    const values = await this.defaultValues(tx, contractId);
    await this.writeVersion(tx, contractId, versionId, 1, clauses, annexes.map((a) => ({ ...a, data: null })), values, customTypes(tv.variablesSchema), now, userId, null);
  }

  /** Variables pré-remplies : client, prestataire (tenant), contrat. */
  private async defaultValues(tx: any, contractId: string): Promise<Record<string, unknown>> {
    const c = await tx.contract.findUnique({ where: { id: contractId }, include: { customer: true, tenant: true } });
    const cu = c.customer;
    const months = c.startDate && c.endDate ? monthsBetween(c.startDate, c.endDate) : null;
    const address = [cu.addressLine1, cu.addressLine2, [cu.postalCode, cu.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const out: Record<string, unknown> = {
      'client.raisonSociale': cu.legalName ?? cu.name,
      'client.siren': cu.siren,
      'client.tva': cu.vatNumber,
      'client.adresse': address || null,
      'prestataire.raisonSociale': c.tenant.name,
      'contrat.reference': c.reference,
      'contrat.dateEffet': c.startDate ? c.startDate.toISOString().slice(0, 10) : null,
      'contrat.dureeMois': months,
      'contrat.preavis': c.noticePeriodMonths != null ? `${c.noticePeriodMonths} mois` : c.noticePeriodDays != null ? `${c.noticePeriodDays} jours` : null,
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  async get(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!c.currentVersionId) return { versionId: null, clauses: [], annexes: [], variables: { values: {}, missing: [], definitions: {} }, diff: null };
      const v = await tx.contractVersion.findUnique({
        where: { id: c.currentVersionId },
        include: {
          clauses: { orderBy: { position: 'asc' } },
          annexes: { orderBy: { position: 'asc' } },
        },
      });
      const reviews = await tx.contractClauseReview.findMany({ where: { contractId }, orderBy: { reviewedAt: 'asc' } });
      const template = c.templateVersionId ? await this.templateClauses(tx, c.templateVersionId) : null;
      const stored = (v!.variables ?? {}) as { values?: Record<string, unknown>; custom?: Record<string, VariableType> };
      const clauses = v!.clauses.map((cl: any) => ({
        id: cl.id, clauseKey: cl.clauseKey, position: cl.position, title: cl.title, category: cl.category,
        bodyHtml: cl.bodyHtml, origin: cl.origin, sourceClauseVersionId: cl.sourceClauseVersionId,
        ai: cl.origin === 'AI'
          ? { risk: cl.aiRisk, justification: cl.aiJustification, sources: cl.aiSources, review: latestReview(reviews, cl) }
          : null,
      }));
      return {
        versionId: v!.id,
        versionNumber: v!.versionNumber,
        clauses,
        annexes: v!.annexes.map((a: any) => ({ id: a.id, position: a.position, kind: a.kind, title: a.title, bodyHtml: a.bodyHtml, data: a.data })),
        variables: {
          values: stored.values ?? {},
          custom: stored.custom ?? {},
          missing: c.missingVariables,
          definitions: VARIABLE_REGISTRY,
        },
        diff: template ? diffClauses(template, v!.clauses.map((cl: any) => ({ key: cl.clauseKey, title: cl.title, bodyHtml: cl.bodyHtml }))) : null,
        unreviewedAiClauses: c.unreviewedAiClauses,
      };
    });
  }

  private async templateClauses(tx: any, templateVersionId: string) {
    const rows = await tx.templateClause.findMany({
      where: { templateVersionId },
      orderBy: { position: 'asc' },
      include: { clauseVersion: { include: { item: true } } },
    });
    if (!rows.length) return null;
    return rows.map((r: any) => ({
      key: r.clauseVersion.item.code, title: r.clauseVersion.item.title, bodyHtml: r.clauseVersion.bodyHtml, required: r.required,
    }));
  }

  // -------------------------------------------------------------------------
  // Enregistrement (nouvelle version)
  // -------------------------------------------------------------------------

  async save(scope: Scope, contractId: string, input: SaveStructure, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      if (!c) throw new NotFoundException('Contrat introuvable');

      // EDIT_CONTENT passe par la machine : APPROVED → DRAFT (validation
      // invalidée), IN_NEGOTIATION reste en négociation (validation invalidée),
      // tout autre état non éditable → 409 (verrouillage en signature, V2-LOCK).
      const { event, next } = editContent(c, scope.userId, now);

      const prev = c.currentVersionId
        ? await tx.contractVersion.findUnique({
            where: { id: c.currentVersionId },
            select: { variables: true, clauses: { select: { clauseKey: true, origin: true, aiRisk: true, aiJustification: true, aiSources: true } } },
          })
        : null;
      const prevAi = new Map((prev?.clauses ?? []).filter((cl) => cl.origin === 'AI').map((cl) => [cl.clauseKey, cl]));
      const prevVars = (prev?.variables ?? {}) as { values?: Record<string, unknown>; custom?: Record<string, VariableType> };
      const custom = prevVars.custom ?? {};
      // Les valeurs déjà saisies (ou pré-remplies) sont conservées ; l'appel
      // ne transmet que celles qu'il modifie.
      const values = { ...(prevVars.values ?? {}), ...input.variables };
      const max = await tx.contractVersion.aggregate({ where: { contractId }, _max: { versionNumber: true } });
      const versionId = uuidv7();
      const clauses: ClauseInput[] = input.clauses.map((cl, i) => ({
        clauseKey: cl.clauseKey ?? `C${String(i + 1).padStart(2, '0')}-${uuidv7().slice(-6).toUpperCase()}`,
        title: cl.title,
        category: cl.category,
        bodyHtml: cl.bodyHtml,
        origin: cl.origin,
        sourceClauseVersionId: cl.sourceClauseVersionId ?? null,
        ...aiMetadata(cl, prevAi),
      }));
      await this.writeVersion(
        tx, contractId, versionId, (max._max.versionNumber ?? 0) + 1, clauses,
        input.annexes.map((a) => ({ kind: a.kind, title: a.title, bodyHtml: a.bodyHtml ?? null, data: a.data ?? null })),
        values, custom, now, scope.userId, input.changeSummary ?? null,
      );
      await persistTransition(tx, contractId, event, { ...next, currentVersionId: versionId }, now, scope.userId);
      return this.summary(tx, contractId, versionId);
    });
  }

  /**
   * Clauses rédigées par IA (lot 6) : ajoutées au contenu courant ou le
   * remplaçant ; annexes et variables conservées. Chaque clause porte son
   * origine AI, son risque, sa justification et ses sources ; la revue
   * humaine clause par clause reste obligatoire avant soumission (V2-AI).
   */
  async saveAiClauses(
    scope: Scope,
    contractId: string,
    aiClauses: Omit<ClauseInput, 'clauseKey' | 'origin' | 'sourceClauseVersionId'>[],
    mode: 'replace' | 'append',
    changeSummary: string,
    now: Date,
  ) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const { event, next } = editContent(c, scope.userId, now);
      const prev = c.currentVersionId
        ? await tx.contractVersion.findUnique({
            where: { id: c.currentVersionId },
            include: { clauses: { orderBy: { position: 'asc' } }, annexes: { orderBy: { position: 'asc' } } },
          })
        : null;
      const kept: ClauseInput[] = mode === 'append' && prev
        ? prev.clauses.map((cl) => ({
            clauseKey: cl.clauseKey, title: cl.title, category: cl.category, bodyHtml: cl.bodyHtml, origin: cl.origin,
            sourceClauseVersionId: cl.sourceClauseVersionId, aiRisk: cl.aiRisk, aiJustification: cl.aiJustification, aiSources: cl.aiSources,
          }))
        : [];
      const added: ClauseInput[] = aiClauses.map((cl) => ({
        ...cl, clauseKey: `AI-${uuidv7().slice(-10).toUpperCase()}`, origin: 'AI', sourceClauseVersionId: null,
      }));
      const prevVars = (prev?.variables ?? {}) as { values?: Record<string, unknown>; custom?: Record<string, VariableType> };
      const max = await tx.contractVersion.aggregate({ where: { contractId }, _max: { versionNumber: true } });
      const versionId = uuidv7();
      await this.writeVersion(
        tx, contractId, versionId, (max._max.versionNumber ?? 0) + 1, [...kept, ...added],
        (prev?.annexes ?? []).map((a) => ({ kind: a.kind, title: a.title, bodyHtml: a.bodyHtml, data: a.data })),
        prevVars.values ?? {}, prevVars.custom ?? {}, now, scope.userId, changeSummary,
      );
      await persistTransition(tx, contractId, event, { ...next, currentVersionId: versionId }, now, scope.userId);
      if (mode === 'replace' && c.origin === 'NATIVE') await tx.contract.update({ where: { id: contractId }, data: { origin: 'AI' } });
      return this.summary(tx, contractId, versionId);
    });
  }

  /**
   * Écrit une version : assainit, substitue les variables, compose le
   * document, enregistre clauses et annexes, puis met à jour le contrat
   * (version courante, variables manquantes, clauses IA à revoir).
   */
  async writeVersion(
    tx: any,
    contractId: string,
    versionId: string,
    versionNumber: number,
    clauses: ClauseInput[],
    annexes: { kind: string; title: string; bodyHtml?: string | null; data?: unknown }[],
    values: Record<string, unknown>,
    custom: Record<string, VariableType>,
    now: Date,
    userId: string,
    changeSummary: string | null,
  ) {
    const c = await tx.contract.findUnique({ where: { id: contractId } });
    const cleanClauses = clauses.map((cl) => ({ ...cl, bodyHtml: sanitizeContractHtml(cl.bodyHtml) }));
    const cleanAnnexes = annexes.map((a) => ({ ...a, bodyHtml: a.bodyHtml != null ? sanitizeContractHtml(a.bodyHtml) : null }));

    const names = [...new Set([...cleanClauses, ...cleanAnnexes].flatMap((x) => extractVariables(x.bodyHtml ?? '')))];
    const check = validateVariables(names, values, custom);
    // Les valeurs invalides ou inconnues sont REFUSÉES (400) ; les manquantes
    // sont tolérées en brouillon mais bloquent la soumission (V2-VAR).
    if (check.invalid.length || check.unknown.length) {
      throw new ConflictException({
        code: 'VARIABLES_INVALID',
        detail: 'Variables invalides ou inconnues du registre.',
        invalid: check.invalid,
        unknown: check.unknown,
      });
    }
    const allValues = { ...values, ...check.values };
    const missing = new Set<string>(check.missing);
    const render = (html: string) => {
      const r = renderVariables(html, allValues);
      r.missing.forEach((m) => missing.add(m));
      return r.html;
    };

    const annexHtml: { title: string; html: string }[] = [];
    for (const a of cleanAnnexes) annexHtml.push({ title: a.title, html: await this.annexHtml(tx, contractId, a, render, now) });
    const bodyHtml = composeContractBody({
      title: c.title,
      reference: c.reference,
      clauses: cleanClauses.map((cl) => ({ title: cl.title, bodyHtml: render(cl.bodyHtml) })),
      annexes: annexHtml,
    });

    await tx.contractVersion.create({
      data: {
        id: versionId, tenantId: c.tenantId, customerId: c.customerId, contractId, versionNumber,
        bodyHtml, variables: { values: allValues, custom } as never, changeSummary,
        createdAt: now, createdByUserId: userId,
      },
    });
    await tx.contractClause.createMany({
      data: cleanClauses.map((cl, i) => ({
        id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId, versionId,
        position: i + 1, clauseKey: cl.clauseKey, category: cl.category as never, title: cl.title,
        bodyHtml: cl.bodyHtml, origin: cl.origin as never, sourceClauseVersionId: cl.sourceClauseVersionId,
        aiRisk: (cl.aiRisk ?? null) as never, aiJustification: cl.aiJustification ?? null,
        aiSources: (cl.aiSources ?? undefined) as never,
      })),
    });
    if (cleanAnnexes.length) {
      await tx.annex.createMany({
        data: cleanAnnexes.map((a, i) => ({
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId, versionId,
          position: i + 1, kind: a.kind as never, title: a.title, bodyHtml: a.bodyHtml, data: (a.data ?? undefined) as never,
        })),
      });
    }
    const unreviewed = await this.countUnreviewedAi(tx, contractId, versionId);
    await tx.contract.update({
      where: { id: contractId },
      data: { currentVersionId: versionId, missingVariables: missing.size, unreviewedAiClauses: unreviewed, updatedAt: now },
    });
  }

  /** Annexe générée : grille tarifaire (lot 3) ou liste d'actifs ; sinon corps rédigé. */
  private async annexHtml(
    tx: any,
    contractId: string,
    a: { kind: string; bodyHtml?: string | null; data?: unknown },
    render: (h: string) => string,
    now: Date,
  ): Promise<string> {
    if (a.bodyHtml) return render(a.bodyHtml);
    if (a.kind === 'PRICING_GRID') {
      const grid = this.pricingGrid ? await this.pricingGrid.renderGrid(tx, contractId, now) : null;
      return grid ?? '<p><em>Grille tarifaire : barème du contrat en vigueur à la date d’effet (générée à partir de la tarification).</em></p>';
    }
    if (a.kind === 'ASSETS') {
      const items = ((a.data as { items?: { designation?: string; reference?: string; quantity?: number }[] } | null)?.items ?? []);
      const rows = items
        .map((it) => `<tr><td>${esc(it.designation ?? '')}</td><td>${esc(it.reference ?? '')}</td><td>${Number(it.quantity ?? 1)}</td></tr>`)
        .join('');
      return `<table><thead><tr><th>Désignation</th><th>Référence</th><th>Quantité</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // Revue des clauses (obligatoire pour les clauses IA)
  // -------------------------------------------------------------------------

  async reviewClause(scope: Scope, contractId: string, clauseId: string, decision: 'APPROVED' | 'REJECTED', comment: string | undefined, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      const cl = await tx.contractClause.findUnique({ where: { id: clauseId } });
      if (!c || !cl || cl.contractId !== contractId) throw new NotFoundException('Clause introuvable');
      if (cl.versionId !== c.currentVersionId) {
        throw new ConflictException({ code: 'CLAUSE_OUTDATED', detail: 'Cette clause appartient à une version antérieure.' });
      }
      await tx.contractClauseReview.create({
        data: {
          id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId, clauseId,
          decision, comment: comment ?? null, reviewedByUserId: scope.userId, reviewedAt: now,
        },
      });
      const unreviewed = await this.countUnreviewedAi(tx, contractId, c.currentVersionId);
      await tx.contract.update({ where: { id: contractId }, data: { unreviewedAiClauses: unreviewed, updatedAt: now } });
      return { clauseId, decision, unreviewedAiClauses: unreviewed };
    });
  }

  /**
   * Clauses IA de la version sans validation humaine. Une validation vaut
   * pour un TEXTE : elle suit la clause (même `clause_key`) d'une version à
   * l'autre tant que son corps n'a pas changé, et tombe dès qu'il change.
   * Aucune décision n'est recopiée ni fabriquée : on relit l'historique.
   */
  private async countUnreviewedAi(tx: any, contractId: string, versionId: string): Promise<number> {
    const ai = await tx.contractClause.findMany({ where: { versionId, origin: 'AI' } });
    if (!ai.length) return 0;
    const reviews = await tx.contractClauseReview.findMany({
      where: { contractId },
      include: { clause: { select: { clauseKey: true, bodyHtml: true } } },
      orderBy: { reviewedAt: 'asc' },
    });
    let n = 0;
    for (const cl of ai) {
      const same = reviews.filter((r: any) => r.clause.clauseKey === cl.clauseKey && r.clause.bodyHtml === cl.bodyHtml);
      const last = same.at(-1);
      if (!last || last.decision !== 'APPROVED') n++;
    }
    return n;
  }

  private async summary(tx: any, contractId: string, versionId: string) {
    const c = await tx.contract.findUnique({
      where: { id: contractId },
      select: { id: true, status: true, missingVariables: true, unreviewedAiClauses: true, approvedVersionId: true },
    });
    const v = await tx.contractVersion.findUnique({ where: { id: versionId }, select: { versionNumber: true } });
    return { ...c, versionId, versionNumber: v.versionNumber };
  }
}

function latestReview(reviews: any[], clause: any) {
  const same = reviews.filter((r) => r.clauseId === clause.id);
  const last = same.at(-1);
  return last ? { decision: last.decision, by: last.reviewedByUserId, at: last.reviewedAt, comment: last.comment } : null;
}

function customTypes(schema: unknown): Record<string, VariableType> {
  // Schéma historique (JSON Schema) : les propriétés hors registre sont des
  // variables propres au modèle, de type texte.
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const out: Record<string, VariableType> = {};
  for (const name of Object.keys(props)) if (!VARIABLE_REGISTRY[name]) out[name] = 'string';
  return out;
}

function monthsBetween(start: Date, end: Date): number {
  const d = new Date(end.getTime() + 86_400_000); // terme inclus
  return (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + (d.getUTCMonth() - start.getUTCMonth());
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/**
 * EDIT_CONTENT passe par la machine : APPROVED → DRAFT (validation
 * invalidée), IN_NEGOTIATION reste en négociation (validation invalidée),
 * tout autre état non éditable → 409 (verrouillage en signature, V2-LOCK).
 */
function editContent(c: Parameters<typeof toContractSnapshot>[0], userId: string, now: Date) {
  const event: ContractEvent = { type: 'EDIT_CONTENT', actorUserId: userId };
  try {
    return { event, next: applyEvent(toContractSnapshot(c), event, now) };
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      throw new ConflictException({ code: 'RM-04', detail: `Le contenu d’un contrat « ${c.status} » n’est pas modifiable.`, allowedTransitions: e.allowedTransitions });
    }
    if (e instanceof BusinessRuleError) throw new ConflictException({ code: e.code, detail: e.message });
    throw e;
  }
}

/** Métadonnées IA d'une clause enregistrée : fournies, sinon celles de la version précédente. */
function aiMetadata(
  cl: SaveStructure['clauses'][number],
  prevAi: Map<string, { aiRisk: string | null; aiJustification: string | null; aiSources: unknown }>,
) {
  if (cl.origin !== 'AI') return {};
  if (cl.ai) return { aiRisk: cl.ai.risk, aiJustification: cl.ai.justification, aiSources: cl.ai.sources };
  const p = cl.clauseKey ? prevAi.get(cl.clauseKey) : undefined;
  return p ? { aiRisk: p.aiRisk, aiJustification: p.aiJustification, aiSources: p.aiSources } : {};
}
