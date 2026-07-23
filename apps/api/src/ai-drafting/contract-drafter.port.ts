export const CONTRACT_DRAFTER = Symbol('CONTRACT_DRAFTER');

export interface DraftInput {
  readonly prompt: string;
  readonly category?: string;
  readonly context?: string;
}

export interface DraftResult {
  bodyHtml: string;
  suggestedVariables: string[];
}

/**
 * Rédacteur de brouillon de contrat (port). Abstrait le fournisseur LLM :
 * les services dépendent du PORT, pas de l'adaptateur (cf. DOCUMENT_STORAGE,
 * JOB_QUEUE). En test, un stub évite tout appel réseau.
 */
export interface ContractDrafter {
  draft(input: DraftInput): Promise<DraftResult>;
}
