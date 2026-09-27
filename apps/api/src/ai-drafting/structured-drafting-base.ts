import { assertNoLeak, type KnownEntities } from '@lsi/domain';
import type {
  ImportExtractInput,
  CompanyResearchInput,
  ProposalDraftInput,
  ProposalRephraseInput,
  AiCallResult,
  CompareClauseInput,
  ContractDraftingProvider,
  DetectMissingClausesInput,
  DraftedClause,
  DraftingProviderName,
  ExplainClauseInput,
  ModelSelection,
  ProviderUsage,
  RephraseClauseInput,
  RephraseResult,
  SourceRef,
  StructuredDraftInput,
  StructuredDraftResult,
} from './contract-drafting-provider.port.js';
import {
  buildCompareTask,
  buildDraftTask,
  buildExplainTask,
  buildImportExtractTask,
  buildCompanyResearchTask,
  buildProposalDraftTask,
  buildProposalRephraseTask,
  buildMissingClausesTask,
  buildRephraseTask,
  type StructuredTask,
} from './drafting-prompts.js';
import type {
  ClauseOutput, CompanyResearchOutput, CompareOutput, ExplainOutput, ImportExtractOutput, MissingClausesOutput,
  ProposalDraftOutput, ProposalRephraseOutput,
} from './drafting-schemas.js';
import { stripUrlsAndMarkers } from './drafting-sources.js';

/** Ce que l'adaptateur rend pour UN appel structuré, avant post-traitement commun. */
export interface RawStructuredResult<T> {
  readonly data: T;
  readonly sources: readonly SourceRef[];
  readonly usage: ProviderUsage;
  readonly model?: string;
  readonly warnings: readonly string[];
  readonly raw: { readonly request: unknown; readonly response: unknown };
}

/**
 * Socle commun des fournisseurs structurés : construction des tâches,
 * garde-fou de pseudonymisation, nettoyage des URL dans le texte généré.
 * Un adaptateur n'implémente QUE `runStructured` (le transport) — la politique
 * (quoi envoyer, quoi garder) est ainsi identique pour Perplexity et Claude.
 */
export abstract class StructuredDraftingBase implements ContractDraftingProvider {
  abstract readonly name: DraftingProviderName;

  protected abstract runStructured<T>(task: StructuredTask<T>, selection: ModelSelection | undefined): Promise<RawStructuredResult<T>>;

  /**
   * Refuse l'envoi si une valeur sensible subsiste. Appliqué au texte EXACT
   * qui partirait (instructions + entrée), avant tout appel réseau. Les motifs
   * génériques (e-mail, IBAN, montant…) sont vérifiés même sans entité connue.
   */
  private async run<T>(task: StructuredTask<T>, selection: ModelSelection | undefined, known: KnownEntities | undefined) {
    assertNoLeak(`${task.instructions}\n\n${task.input}`, known ?? {});
    return this.runStructured(task, selection);
  }

  private static cleanClause(c: ClauseOutput, warnings: string[]): DraftedClause {
    const text = stripUrlsAndMarkers(c.text);
    const justification = stripUrlsAndMarkers(c.justification);
    const title = stripUrlsAndMarkers(c.title);
    const removedUrls = [...title.removedUrls, ...text.removedUrls, ...justification.removedUrls];
    if (removedUrls.length > 0) {
      warnings.push(`URL retirée du texte généré (clause « ${title.text} ») : une URL écrite par le modèle n'est pas une source.`);
    }
    return {
      title: title.text,
      text: text.text,
      category: c.category,
      riskLevel: c.riskLevel,
      justification: justification.text,
      removedUrls,
    };
  }

  private static envelope<T>(name: DraftingProviderName, r: RawStructuredResult<unknown>, data: T, warnings: string[]): AiCallResult<T> {
    return {
      data,
      sources: r.sources,
      usage: r.usage,
      provider: name,
      ...(r.model ? { model: r.model } : {}),
      warnings,
      raw: r.raw,
    };
  }

  async draftStructured(input: StructuredDraftInput): Promise<StructuredDraftResult> {
    const r = await this.run(buildDraftTask(input), input.selection, input.knownEntities);
    const warnings = [...r.warnings];
    const clauses = r.data.clauses.map((c) => StructuredDraftingBase.cleanClause(c, warnings));
    const suggestedAnnexes = r.data.suggestedAnnexes.map((a) => ({
      title: stripUrlsAndMarkers(a.title).text,
      description: stripUrlsAndMarkers(a.description).text,
    }));
    const data = { clauses, suggestedAnnexes };
    return { ...StructuredDraftingBase.envelope(this.name, r, data, warnings), ...data };
  }

  async rephraseClause(input: RephraseClauseInput): Promise<AiCallResult<RephraseResult>> {
    const r = await this.run(buildRephraseTask(input), input.selection, input.knownEntities);
    const warnings = [...r.warnings];
    const data = { clause: StructuredDraftingBase.cleanClause(r.data.clause, warnings), changes: r.data.changes };
    return StructuredDraftingBase.envelope(this.name, r, data, warnings);
  }

  async explainClause(input: ExplainClauseInput): Promise<AiCallResult<ExplainOutput>> {
    const r = await this.run(buildExplainTask(input), input.selection, input.knownEntities);
    const data: ExplainOutput = {
      summary: stripUrlsAndMarkers(r.data.summary).text,
      keyPoints: r.data.keyPoints.map((p) => stripUrlsAndMarkers(p).text),
      pointsOfAttention: r.data.pointsOfAttention.map((p) => stripUrlsAndMarkers(p).text),
    };
    return StructuredDraftingBase.envelope(this.name, r, data, [...r.warnings]);
  }

  async compareClause(input: CompareClauseInput): Promise<AiCallResult<CompareOutput>> {
    const r = await this.run(buildCompareTask(input), input.selection, input.knownEntities);
    // Un id inventé par le modèle est ramené à « aucun » : on ne pointe que vers la bibliothèque fournie.
    const known = new Set(input.libraryItems.map((i) => i.id));
    const warnings = [...r.warnings];
    let closestItemId = r.data.closestItemId;
    if (closestItemId !== '' && !known.has(closestItemId)) {
      warnings.push('Identifiant de bibliothèque inconnu renvoyé par le modèle : ignoré.');
      closestItemId = '';
    }
    return StructuredDraftingBase.envelope(this.name, r, { ...r.data, closestItemId }, warnings);
  }

  async detectMissingClauses(input: DetectMissingClausesInput): Promise<AiCallResult<MissingClausesOutput>> {
    const r = await this.run(buildMissingClausesTask(input), input.selection, input.knownEntities);
    const data: MissingClausesOutput = {
      missing: r.data.missing.map((m) => ({ ...m, reason: stripUrlsAndMarkers(m.reason).text })),
    };
    return StructuredDraftingBase.envelope(this.name, r, data, [...r.warnings]);
  }

  async extractImportMetadata(input: ImportExtractInput): Promise<AiCallResult<ImportExtractOutput>> {
    const r = await this.run(buildImportExtractTask(input), input.selection, input.knownEntities);
    return StructuredDraftingBase.envelope(this.name, r, r.data, [...r.warnings]);
  }

  async draftProposalSections(input: ProposalDraftInput): Promise<AiCallResult<ProposalDraftOutput>> {
    const r = await this.run(buildProposalDraftTask(input), input.selection, input.knownEntities);
    const warnings = [...r.warnings];
    const sections = r.data.sections.map((s) => {
      const t = stripUrlsAndMarkers(s.text);
      if (t.removedUrls.length) warnings.push(`URL retirée du texte généré (section « ${s.title} »).`);
      return { ...s, title: stripUrlsAndMarkers(s.title).text, text: t.text };
    });
    const data = { sections, pointsToVerify: r.data.pointsToVerify.map((p) => stripUrlsAndMarkers(p).text) };
    return StructuredDraftingBase.envelope(this.name, r, data, warnings);
  }

  async rephraseProposalText(input: ProposalRephraseInput): Promise<AiCallResult<ProposalRephraseOutput>> {
    const r = await this.run(buildProposalRephraseTask(input), input.selection, input.knownEntities);
    return StructuredDraftingBase.envelope(this.name, r, { ...r.data, text: stripUrlsAndMarkers(r.data.text).text }, [...r.warnings]);
  }

  async researchCompany(input: CompanyResearchInput): Promise<AiCallResult<CompanyResearchOutput>> {
    // Garde-fou sans entité connue : les motifs génériques (e-mail, téléphone,
    // IBAN, montant…) sont refusés — seuls raison sociale et site web partent.
    const r = await this.run(buildCompanyResearchTask(input), input.selection, undefined);
    const data = {
      ...r.data,
      summary: stripUrlsAndMarkers(r.data.summary).text,
      recentNews: r.data.recentNews.map((n) => ({ ...n, title: stripUrlsAndMarkers(n.title).text })),
    };
    return StructuredDraftingBase.envelope(this.name, r, data, [...r.warnings]);
  }
}
