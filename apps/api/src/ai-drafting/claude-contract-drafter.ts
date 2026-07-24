import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';

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

/**
 * Adaptateur prod. Instancié UNIQUEMENT quand ANTHROPIC_API_KEY est présente
 * (cf. la fabrique dans app.module) : `new Anthropic()` lit la clé de l'env.
 */
@Injectable()
export class ClaudeContractDrafter implements ContractDrafter {
  private readonly client = new Anthropic();

  async draft(input: DraftInput): Promise<DraftResult> {
    const res = await this.client.messages.parse({
      model: 'claude-opus-4-8',
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
}
