import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { withScope, type Scope } from '@lsi/persistence';
import { escapeHtml, pseudonymize, REVISION_INDICES, type KnownEntities, type PseudonymizationMap } from '@lsi/domain';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';
import { StructureService } from '../structure/structure.service.js';
import { AiGateway } from './ai-gateway.service.js';
import type { ClauseInput as PortClause, DraftedClause, SourceRef, TemplateClauseInput } from './contract-drafting-provider.port.js';
import { pseudonymizeDraftInput, reidentifyDeep } from './drafting-pseudonymization.js';
import { SCHEMA_NAMES, type ClauseCategory, type ImportExtractOutput } from './drafting-schemas.js';

export const AiDraftContractSchema = z
  .object({
    needs: z.string().trim().min(10, 'Décrivez le besoin (10 caractères au moins).').max(8_000),
    services: z.array(z.string().trim().min(1).max(300)).max(40).default([]),
    contractType: z.string().trim().min(1).max(200).optional(),
    mode: z.enum(['replace', 'append']).default('replace'),
  })
  .strict();
export type AiDraftContract = z.infer<typeof AiDraftContractSchema>;

export const AiClauseActionSchema = z.object({ action: z.enum(['rephrase', 'harden', 'explain', 'compare']) }).strict();

/** Catégories du fournisseur (fines) → catégories du modèle de données. */
const CATEGORY_MAP: Record<ClauseCategory, string> = {
  OBJET: 'OBJET', DEFINITIONS: 'OBJET', DUREE: 'DUREE', PRIX: 'PRIX', PAIEMENT: 'PRIX', REVISION: 'PRIX',
  NIVEAUX_DE_SERVICE: 'SLA', OBLIGATIONS_PRESTATAIRE: 'DIVERS', OBLIGATIONS_CLIENT: 'DIVERS',
  RESPONSABILITE: 'RESPONSABILITE', ASSURANCE: 'ASSURANCE', CONFIDENTIALITE: 'CONFIDENTIALITE',
  DONNEES_PERSONNELLES: 'RGPD', SECURITE: 'DIVERS', PROPRIETE_INTELLECTUELLE: 'PROPRIETE_INTELLECTUELLE',
  SOUS_TRAITANCE: 'DIVERS', RESILIATION: 'RESILIATION', REVERSIBILITE: 'RESILIATION', FORCE_MAJEURE: 'DIVERS',
  LITIGES: 'DIVERS', AUTRE: 'DIVERS',
};

/** Texte brut d'une clause HTML (ce qui part au fournisseur, après pseudonymisation). */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Texte généré → HTML sûr : échappé, un paragraphe par bloc. */
export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * Assistance IA sur un contrat (lot 6, brief §6) : rédaction structurée,
 * aide clause par clause, clauses manquantes, extraction assistée d'un import.
 *
 * Invariants : seul du texte PSEUDONYMISÉ sort (garde-fou `assertNoLeak`
 * dans le socle des fournisseurs) ; les valeurs réelles sont réinjectées ici,
 * côté serveur ; rien n'est appliqué au contrat sans action humaine, sauf la
 * rédaction demandée explicitement — dont chaque clause reste « à revoir ».
 */
@Injectable()
export class ContractAiService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly structure: StructureService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  async draft(scope: Scope, contractId: string, input: AiDraftContract, now: Date) {
    const ctx = await this.context(scope, contractId);
    const { input: pseudo, map } = pseudonymizeDraftInput(
      {
        contractType: input.contractType ?? ctx.contractType,
        needs: input.needs,
        services: input.services,
        templateClauses: ctx.clauses.map((c) => ({ title: c.title, text: c.text })),
      },
      ctx.known,
    );
    const r = await this.gateway.call(scope, { operation: 'DRAFT', contractId, schemaName: SCHEMA_NAMES.draft },
      (p, selection) => p.draftStructured({ ...pseudo, ...(selection ? { selection } : {}) }), now);
    const draft = reidentifyDeep({ clauses: r.data.clauses, suggestedAnnexes: r.data.suggestedAnnexes }, map);
    const sources = r.sources.map((s) => ({ url: s.url, title: s.title }));
    const saved = await this.structure.saveAiClauses(
      scope, contractId,
      draft.clauses.map((c) => this.toClause(c, sources)),
      input.mode,
      `Projet rédigé par IA (${r.provider}) — ${draft.clauses.length} clause(s) à revoir`,
      now,
    );
    return { ...saved, provider: r.provider, model: r.model ?? null, sources: r.sources, warnings: r.warnings, suggestedAnnexes: draft.suggestedAnnexes };
  }

  /** Suggestion sur UNE clause — jamais appliquée : l'utilisateur la reprend s'il le souhaite. */
  async assistClause(scope: Scope, contractId: string, clauseKey: string, action: 'rephrase' | 'harden' | 'explain' | 'compare', now: Date) {
    const ctx = await this.context(scope, contractId);
    const clause = ctx.clauses.find((c) => c.key === clauseKey);
    if (!clause) throw new NotFoundException('Clause introuvable dans la version courante');
    let map: PseudonymizationMap = {};
    const p = (t: string) => { const x = pseudonymize(t, ctx.known, { map }); map = x.map; return x.text; };
    const pc: PortClause = { title: p(clause.title), text: p(clause.text) };
    const common = { knownEntities: ctx.known };

    if (action === 'rephrase' || action === 'harden') {
      const r = await this.gateway.call(scope, { operation: action === 'harden' ? 'HARDEN' : 'REPHRASE', contractId, schemaName: SCHEMA_NAMES.rephrase },
        (prov, selection) => prov.rephraseClause({ ...common, clause: pc, mode: action === 'harden' ? 'durcir' : 'reformuler', contractType: p(ctx.contractType), ...(selection ? { selection } : {}) }), now);
      const data = reidentifyDeep(r.data, map);
      return {
        action, provider: r.provider, sources: r.sources, warnings: r.warnings, changes: data.changes,
        suggestion: { title: data.clause.title, bodyHtml: textToHtml(data.clause.text), riskLevel: data.clause.riskLevel, justification: data.clause.justification },
      };
    }
    if (action === 'explain') {
      const r = await this.gateway.call(scope, { operation: 'EXPLAIN', contractId, schemaName: SCHEMA_NAMES.explain },
        (prov, selection) => prov.explainClause({ ...common, clause: pc, ...(selection ? { selection } : {}) }), now);
      return { action, provider: r.provider, sources: r.sources, warnings: r.warnings, explanation: reidentifyDeep(r.data, map) };
    }
    const library = await withScope(scope, (tx) => tx.clauseLibraryItem.findMany({
      where: { archivedAt: null, currentVersionId: { not: null } },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
      take: 30,
    }));
    const items = library.filter((i) => i.versions[0]).map((i) => ({ id: i.id, title: p(i.title), text: p(htmlToText(i.versions[0]!.bodyHtml)) }));
    const r = await this.gateway.call(scope, { operation: 'COMPARE', contractId, schemaName: SCHEMA_NAMES.compare },
      (prov, selection) => prov.compareClause({ ...common, clause: pc, libraryItems: items, ...(selection ? { selection } : {}) }), now);
    return { action, provider: r.provider, sources: r.sources, warnings: r.warnings, comparison: reidentifyDeep(r.data, map) };
  }

  async missingClauses(scope: Scope, contractId: string, now: Date) {
    const ctx = await this.context(scope, contractId);
    let map: PseudonymizationMap = {};
    const p = (t: string) => { const x = pseudonymize(t, ctx.known, { map }); map = x.map; return x.text; };
    const r = await this.gateway.call(scope, { operation: 'MISSING', contractId, schemaName: SCHEMA_NAMES.missing },
      (prov, selection) => prov.detectMissingClauses({
        knownEntities: ctx.known, contractType: p(ctx.contractType),
        draftClauses: ctx.clauses.map((c) => ({ title: p(c.title), text: p(c.text) })),
        templateClauses: ctx.template.map((c) => ({ title: p(c.title), text: p(c.text) })),
        ...(selection ? { selection } : {}),
      }), now);
    return { provider: r.provider, sources: r.sources, warnings: r.warnings, ...reidentifyDeep(r.data, map) };
  }

  /**
   * Extraction assistée d'un contrat importé : complète UNIQUEMENT les champs
   * que les règles locales n'ont pas trouvés. Chaque valeur doit être adossée
   * à un extrait retrouvé MOT POUR MOT dans le texte OCR — sinon écartée.
   * Rien n'est écrit sur le contrat : la validation humaine reste obligatoire.
   */
  async importExtract(scope: Scope, contractId: string, now: Date) {
    const found = await withScope(scope, async (tx) => {
      const imp = await tx.contractImport.findFirst({ where: { contractId }, include: { ocrText: true, contract: { include: { customer: true } } } });
      if (!imp) throw new NotFoundException('Import introuvable');
      if (!imp.ocrText) throw new ConflictException({ code: 'OCR_PENDING', detail: "Le texte du document n'est pas encore disponible (OCR en cours ou en échec)." });
      return imp;
    });
    const buf = await this.storage.get(found.ocrText!.objectKey, { tenantId: scope.tenantId, customerId: found.customerId });
    if (!buf) throw new NotFoundException('Texte OCR introuvable dans le stockage');
    const original = buf.toString('utf8');
    const known = knownEntitiesOf(found.contract.customer, []);
    const { text, map } = pseudonymize(original.slice(0, 60_000), known);
    const r = await this.gateway.call(scope, { operation: 'IMPORT_EXTRACT', contractId, schemaName: SCHEMA_NAMES.importExtract },
      (prov, selection) => prov.extractImportMetadata({ text, knownEntities: known, ...(selection ? { selection } : {}) }), now);
    const proposed = interpretExtraction(reidentifyDeep(r.data, map), original);

    const current = (found.extraction ?? {}) as Record<string, unknown>;
    const added: string[] = [];
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(proposed)) {
      if (current[k] == null && v) { merged[k] = v; added.push(k); }
    }
    await withScope(scope, (tx) => tx.contractImport.update({
      where: { id: found.id },
      data: { extraction: merged as never, extractionMethod: added.length ? 'RULES+LLM' : found.extractionMethod, updatedAt: now },
    }));
    return { provider: r.provider, added, warnings: r.warnings, extraction: merged };
  }

  // -------------------------------------------------------------------------

  private toClause(c: DraftedClause, sources: { url: string; title: string }[]) {
    return {
      title: c.title.slice(0, 200),
      category: CATEGORY_MAP[c.category] ?? 'DIVERS',
      bodyHtml: textToHtml(c.text),
      aiRisk: c.riskLevel,
      aiJustification: c.justification,
      aiSources: sources as unknown,
    };
  }

  /** Contrat, clauses courantes (texte), clauses du modèle, entités à pseudonymiser. */
  private async context(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, include: { customer: { include: { contacts: true } }, signers: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const v = c.currentVersionId
        ? await tx.contractVersion.findUnique({ where: { id: c.currentVersionId }, include: { clauses: { orderBy: { position: 'asc' } } } })
        : null;
      const tpl = c.templateVersionId
        ? await tx.templateClause.findMany({
            where: { templateVersionId: c.templateVersionId }, orderBy: { position: 'asc' },
            include: { clauseVersion: { include: { item: true } } },
          })
        : [];
      const persons = [
        ...c.customer.contacts.map((k) => `${k.firstName} ${k.lastName}`),
        ...c.signers.map((s) => s.fullName),
      ];
      return {
        contractType: `${c.category} — ${c.title}`,
        clauses: (v?.clauses ?? []).map((cl) => ({ key: cl.clauseKey, title: cl.title, text: htmlToText(cl.bodyHtml) })),
        template: tpl.map((t): TemplateClauseInput => ({ title: t.clauseVersion.item.title, text: htmlToText(t.clauseVersion.bodyHtml) })),
        known: knownEntitiesOf(c.customer, persons, c.customer.contacts),
      };
    });
  }
}

type CustomerLike = {
  name: string; legalName: string | null; siren: string | null; vatNumber: string | null;
  addressLine1: string | null; addressLine2: string | null;
};

/** Données du client à remplacer par des jetons avant tout envoi. */
export function knownEntitiesOf(
  cu: CustomerLike, persons: string[], contacts: { email: string; phone: string | null }[] = [],
): KnownEntities {
  const clean = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && x.trim().length > 1))];
  return {
    clientNames: clean([cu.legalName, cu.name]),
    persons: clean(persons),
    sirens: clean([cu.siren]),
    vatNumbers: clean([cu.vatNumber]),
    addresses: clean([cu.addressLine1, cu.addressLine2]),
    emails: clean(contacts.map((k) => k.email)),
    phones: clean(contacts.map((k) => k.phone)),
  };
}

const LLM_CONFIDENCE = 0.6;

/**
 * Réponse du fournisseur → propositions au format de l'extraction locale.
 * Une valeur n'est retenue que si son extrait figure tel quel dans le texte
 * (espaces normalisés) et si elle se laisse interpréter strictement.
 */
export function interpretExtraction(out: ImportExtractOutput, original: string): Record<string, unknown> {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const flat = norm(original);
  const evidence = (excerpt: string) => {
    const e = norm(excerpt);
    if (e.length < 3) return null;
    const offset = flat.indexOf(e);
    return offset < 0 ? null : { excerpt: e, offset };
  };
  const field = <T>(f: { value: string; excerpt: string }, parse: (v: string) => T | null) => {
    if (!f.value.trim()) return null;
    const ev = evidence(f.excerpt);
    const value = parse(f.value.trim());
    return ev && value !== null ? { value, confidence: LLM_CONFIDENCE, evidence: ev, method: 'LLM' } : null;
  };
  const isoDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
  const int = (v: string) => (/^\d{1,3}$/.test(v) && Number(v) > 0 ? Number(v) : null);
  const cents = (v: string) => {
    const m = v.replace(/\s| |€|EUR|HT/gi, '').match(/^(\d+)(?:[.,](\d{1,2}))?$/);
    return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
  };
  return {
    dateSignature: field(out.dateSignature, isoDate),
    dateEffet: field(out.dateEffet, isoDate),
    dureeMois: field(out.dureeMois, int),
    reconduction: field(out.reconduction, (v) => (['TACITE', 'EXPRESSE', 'AUCUNE'].includes(v.toUpperCase()) ? v.toUpperCase() : null)),
    preavis: field(out.preavis, (v) => {
      const m = v.toUpperCase().match(/^(\d{1,3})\s*(JOURS|MOIS)$/);
      return m ? { quantite: Number(m[1]), unite: m[2] } : null;
    }),
    montantMensuelHtCentimes: field(out.montantMensuelHt, cents),
    montantAnnuelHtCentimes: field(out.montantAnnuelHt, cents),
    indiceRevision: field(out.indiceRevision, (v) => ((REVISION_INDICES as readonly string[]).includes(v.toUpperCase()) ? v.toUpperCase() : null)),
  };
}

export type { SourceRef };
