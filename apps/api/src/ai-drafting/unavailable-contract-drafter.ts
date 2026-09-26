import { ServiceUnavailableException } from '@nestjs/common';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';
import type { AiCallResult, ContractDraftingProvider, RephraseResult, StructuredDraftResult } from './contract-drafting-provider.port.js';
import { AiNotConfiguredError } from './drafting-errors.js';
import type { CompareOutput, ExplainOutput, MissingClausesOutput } from './drafting-schemas.js';

/**
 * Utilisé quand ANTHROPIC_API_KEY est absente : l'app démarre normalement,
 * mais toute tentative de génération renvoie 503. Aucune dépendance au SDK.
 */
export class UnavailableContractDrafter implements ContractDrafter {
  async draft(_input: DraftInput): Promise<DraftResult> {
    throw new ServiceUnavailableException('Assistance IA non configurée.');
  }
}

/**
 * Pendant structuré : aucun fournisseur configuré (ni PERPLEXITY_API_KEY ni
 * ANTHROPIC_API_KEY), ou IA désactivée pour le tenant. Chaque appel lève
 * `AiNotConfiguredError` — aucun appel réseau, aucun texte ne sort.
 */
export class UnavailableDraftingProvider implements ContractDraftingProvider {
  readonly name = 'unavailable' as const;

  constructor(private readonly reason = 'Assistance IA non configurée.') {}

  private fail(): never {
    throw new AiNotConfiguredError(this.reason, 'unavailable');
  }

  async draftStructured(): Promise<StructuredDraftResult> {
    return this.fail();
  }
  async rephraseClause(): Promise<AiCallResult<RephraseResult>> {
    return this.fail();
  }
  async explainClause(): Promise<AiCallResult<ExplainOutput>> {
    return this.fail();
  }
  async compareClause(): Promise<AiCallResult<CompareOutput>> {
    return this.fail();
  }
  async detectMissingClauses(): Promise<AiCallResult<MissingClausesOutput>> {
    return this.fail();
  }
}
