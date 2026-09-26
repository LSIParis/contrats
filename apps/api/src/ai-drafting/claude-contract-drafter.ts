import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';
import type { ModelSelection } from './contract-drafting-provider.port.js';
import {
  AiAuthError,
  AiBadRequestError,
  AiRateLimitError,
  AiSchemaViolationError,
  AiTimeoutError,
  AiUpstreamError,
  type AiDraftingError,
} from './drafting-errors.js';
import type { StructuredTask } from './drafting-prompts.js';
import { StructuredDraftingBase, type RawStructuredResult } from './structured-drafting-base.js';

const DraftSchema = z.object({
  bodyHtml: z.string(),
  suggestedVariables: z.array(z.string()),
});

const SYSTEM_PROMPT = `Tu es un assistant de rédaction de contrats pour LSI, une PME française de maintenance.
Tu produis un BROUILLON de corps de contrat, destiné à être RELU ET VALIDÉ PAR UN JURISTE avant toute utilisation.
Tu n'affirmes jamais une validité juridique et n'inventes pas de clauses légales spécifiques qui ne sont pas demandées.
Contraintes de sortie :
- « bodyHtml » : le corps du contrat en HTML SIMPLE (titres h1..h3, paragraphes p, listes ul/ol/li, strong, em, br). JAMAIS de balise <script> ou <style>, ni d'attribut d'événement (onclick, onload, ...).
- Utilise des variables de la forme {{ nom_en_snake_case }} pour TOUTE donnée à personnaliser (nom du client, dates, montants, durée, adresse, ...). N'écris jamais de valeurs en dur pour ces données.
- « suggestedVariables » : la liste des noms de variables que tu as utilisés.
Réponds en français.`;

function buildUserPrompt(input: DraftInput): string {
  const parts = [`Rédige un brouillon de contrat pour la demande suivante :\n${input.prompt}`];
  if (input.category) parts.push(`Catégorie du contrat : ${input.category}.`);
  if (input.context) parts.push(`Contexte additionnel :\n${input.context}`);
  return parts.join('\n\n');
}

/** Modèle historique de l'adaptateur (inchangé) ; la rédaction structurée accepte un `model` par tenant. */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';

/** Sous-ensemble du SDK utilisé : permet d'injecter un double en test sans réseau. */
export interface AnthropicMessagesClient {
  readonly messages: Pick<Anthropic['messages'], 'parse'>;
}

export interface ClaudeDrafterOptions {
  readonly client?: AnthropicMessagesClient;
  /** Modèle par défaut de la rédaction structurée si le tenant n'en fixe pas. */
  readonly defaultModel?: string;
  /** Délai par appel structuré. Défaut 120 s. */
  readonly timeoutMs?: number;
}

/** Erreur du SDK Anthropic → erreur typée du port (même famille que Perplexity). */
function mapAnthropicError(err: unknown, timeoutMs: number): AiDraftingError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiTimeoutError('Claude : délai dépassé.', 'claude', timeoutMs, { cause: err });
  const status = (err as { status?: unknown } | null)?.status;
  const opts = { cause: err };
  if (status === 401 || status === 403) return new AiAuthError(`Claude ${status} : clé API invalide ou non autorisée.`, 'claude', status, opts);
  if (status === 400 || status === 422) return new AiBadRequestError(`Claude ${status} : requête refusée.`, 'claude', status, opts);
  if (status === 429) return new AiRateLimitError('Claude 429 : quota atteint.', 'claude', undefined, opts);
  return new AiUpstreamError('Claude : erreur du fournisseur.', 'claude', typeof status === 'number' ? status : undefined, opts);
}

/**
 * Adaptateur prod. Instancié UNIQUEMENT quand ANTHROPIC_API_KEY est présente
 * (cf. la fabrique dans app.module) : `new Anthropic()` lit la clé de l'env.
 *
 * Implémente l'ancien port (`draft`, brouillon HTML de modèle) ET le port
 * structuré (`draftStructured` & co, via `StructuredDraftingBase`) : même
 * schéma Zod, même garde-fou de pseudonymisation, même nettoyage que
 * Perplexity. Différence assumée : AUCUNE source — pas de recherche web ici,
 * et les citations natives de l'API sont incompatibles avec la sortie
 * structurée (cf. docs/contrats/05-ia-perplexity.md §12).
 */
@Injectable()
export class ClaudeContractDrafter extends StructuredDraftingBase implements ContractDrafter {
  readonly name = 'claude' as const;
  private readonly client: AnthropicMessagesClient;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeDrafterOptions = {}) {
    super();
    this.client = options.client ?? new Anthropic();
    this.defaultModel = options.defaultModel ?? CLAUDE_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    const res = await this.client.messages.parse({
      model: CLAUDE_DEFAULT_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(DraftSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    });
    const parsed = res.parsed_output;
    if (!parsed) throw new Error('Réponse IA non exploitable.');
    // suggestedVariables sera de toute façon ré-extrait côté service.
    return { bodyHtml: parsed.bodyHtml, suggestedVariables: parsed.suggestedVariables };
  }

  protected async runStructured<T>(task: StructuredTask<T>, selection: ModelSelection | undefined): Promise<RawStructuredResult<T>> {
    const model = selection?.model ?? this.defaultModel;
    // Requête archivable : le schéma JSON plutôt que l'objet `format` du SDK (qui porte une fonction).
    const request = { model, system: task.instructions, input: task.input, output_schema: { name: task.schemaName, schema: task.jsonSchema } };
    let res;
    try {
      res = await this.client.messages.parse(
        {
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium', format: zodOutputFormat(task.schema as z.ZodType<T>) },
          system: task.instructions,
          messages: [{ role: 'user', content: task.input }],
        },
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      // Le SDK lève aussi quand la sortie ne se parse pas contre le schéma.
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        throw new AiSchemaViolationError('Claude : sortie non conforme au schéma, aucun brouillon créé.', 'claude', [], { cause: err });
      }
      throw mapAnthropicError(err, this.timeoutMs);
    }
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') {
      throw new AiSchemaViolationError(`Claude : génération interrompue (${res.stop_reason}), aucun brouillon partiel.`, 'claude');
    }
    // Revalidation locale : on ne délègue pas la conformité au fournisseur.
    const valid = task.schema.safeParse(res.parsed_output);
    if (!valid.success) {
      throw new AiSchemaViolationError(
        'Claude : sortie non conforme au schéma, aucun brouillon créé.',
        'claude',
        valid.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return {
      data: valid.data,
      sources: [],
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model: res.model,
      warnings: ['Rédaction sans recherche web (Claude) : aucune source citée, justifications à vérifier.'],
      raw: { request, response: res },
    };
  }
}
