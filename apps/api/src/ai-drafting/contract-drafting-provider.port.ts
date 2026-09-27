import type { KnownEntities } from '@lsi/domain';
import type { ClauseCategory, CompareOutput, ExplainOutput, ImportExtractOutput, MissingClausesOutput, RiskLevel } from './drafting-schemas.js';

/**
 * Port de rédaction IA STRUCTURÉE (brief §6). Coexiste avec l'ancien port
 * `ContractDrafter` (brouillon HTML de modèle), qui reste inchangé.
 *
 * CONTRAT D'ENTRÉE : tout le texte fourni est DÉJÀ pseudonymisé par
 * l'appelant (`pseudonymizeDraftingInput`). Le fournisseur n'a jamais la table
 * des jetons. Si `knownEntities` est fourni, l'adaptateur vérifie
 * défensivement (`assertNoLeak`) qu'aucune valeur connue ni motif sensible
 * (e-mail, IBAN, montant…) ne subsiste, AVANT tout appel réseau.
 *
 * CONTRAT DE SORTIE : un résultat complet et validé, ou une `AiDraftingError`
 * typée. Jamais de résultat partiel.
 */

export const CONTRACT_DRAFTING_PROVIDER = Symbol('CONTRACT_DRAFTING_PROVIDER');

export type DraftingProviderName = 'perplexity' | 'claude' | 'unavailable';

/**
 * Choix du modèle, PAR APPEL, issu des paramètres du tenant : aucun nom de
 * modèle n'est codé en dur dans l'adaptateur Perplexity. `preset` et `model`
 * peuvent être combinés (le modèle surcharge celui du preset).
 */
export interface ModelSelection {
  readonly model?: string;
  readonly preset?: string;
}

export interface TemplateClauseInput {
  readonly title: string;
  readonly text: string;
  readonly category?: ClauseCategory;
}

interface CommonInput {
  readonly selection?: ModelSelection;
  /** Entités sensibles du dossier, pour le garde-fou `assertNoLeak`. Jamais envoyées. */
  readonly knownEntities?: KnownEntities;
}

export interface StructuredDraftInput extends CommonInput {
  /** Type de contrat (ex. « Infogérance », « Maintenance »). */
  readonly contractType: string;
  /** Description du besoin, pseudonymisée. */
  readonly needs: string;
  /** Services couverts, pseudonymisés. */
  readonly services: readonly string[];
  /** Clauses du contrat type de départ (facultatif). */
  readonly templateClauses?: readonly TemplateClauseInput[];
}

export interface ClauseInput {
  readonly title: string;
  readonly text: string;
  readonly category?: ClauseCategory;
}

export type RephraseMode = 'reformuler' | 'durcir';

export interface RephraseClauseInput extends CommonInput {
  readonly clause: ClauseInput;
  readonly mode: RephraseMode;
  readonly contractType?: string;
}

export interface ExplainClauseInput extends CommonInput {
  readonly clause: ClauseInput;
}

export interface LibraryItemInput {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface CompareClauseInput extends CommonInput {
  readonly clause: ClauseInput;
  readonly libraryItems: readonly LibraryItemInput[];
}

export interface DetectMissingClausesInput extends CommonInput {
  readonly contractType: string;
  readonly draftClauses: readonly ClauseInput[];
  readonly templateClauses: readonly TemplateClauseInput[];
}

/** Texte OCR d'un contrat importé, DÉJÀ pseudonymisé par l'appelant. */
export interface ImportExtractInput extends CommonInput {
  readonly text: string;
}

export interface DraftedClause {
  readonly title: string;
  readonly text: string;
  readonly category: ClauseCategory;
  readonly riskLevel: RiskLevel;
  readonly justification: string;
  /**
   * URLs trouvées DANS le texte généré, retirées du texte et signalées : une
   * URL écrite par le modèle n'est pas une source (elle peut être inventée).
   */
  readonly removedUrls: readonly string[];
}

export interface SuggestedAnnex {
  readonly title: string;
  readonly description: string;
}

/** Source citée : UNIQUEMENT issue des métadonnées de la réponse (résultats de recherche, annotations). */
export interface SourceRef {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  readonly origin: 'search_result' | 'fetch_url' | 'citation';
  readonly date?: string;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Coût facturé par le fournisseur (Perplexity : `usage.cost.total_cost`) ; absent si non communiqué. */
  readonly costUsd?: number;
  /** Nombre d'invocations par outil (`web_search`, `fetch_url`…), si communiqué. */
  readonly toolInvocations?: Readonly<Record<string, number>>;
}

/** Enveloppe commune à tous les appels : à archiver pour l'audit (prompt + réponse brute). */
export interface AiCallResult<T> {
  readonly data: T;
  readonly sources: readonly SourceRef[];
  readonly usage: ProviderUsage;
  readonly provider: DraftingProviderName;
  /** Modèle effectivement utilisé, tel que renvoyé par le fournisseur. */
  readonly model?: string;
  /** Avertissements non bloquants (URL retirée du texte, sources absentes…). */
  readonly warnings: readonly string[];
  /** Requête envoyée (sans en-tête d'authentification) et réponse brute, pour l'audit. */
  readonly raw: { readonly request: unknown; readonly response: unknown };
}

export interface StructuredDraft {
  readonly clauses: readonly DraftedClause[];
  readonly suggestedAnnexes: readonly SuggestedAnnex[];
}

export type StructuredDraftResult = AiCallResult<StructuredDraft> & StructuredDraft;

export interface RephraseResult {
  readonly clause: DraftedClause;
  readonly changes: readonly string[];
}

export interface ContractDraftingProvider {
  readonly name: DraftingProviderName;
  draftStructured(input: StructuredDraftInput): Promise<StructuredDraftResult>;
  rephraseClause(input: RephraseClauseInput): Promise<AiCallResult<RephraseResult>>;
  explainClause(input: ExplainClauseInput): Promise<AiCallResult<ExplainOutput>>;
  compareClause(input: CompareClauseInput): Promise<AiCallResult<CompareOutput>>;
  detectMissingClauses(input: DetectMissingClausesInput): Promise<AiCallResult<MissingClausesOutput>>;
  extractImportMetadata(input: ImportExtractInput): Promise<AiCallResult<ImportExtractOutput>>;
}
