import { describe, test, expect } from 'vitest';
import { PseudonymizationLeakError } from '@lsi/domain';
import { ClaudeContractDrafter, CLAUDE_DEFAULT_MODEL, type AnthropicMessagesClient } from '../../src/ai-drafting/claude-contract-drafter.js';
import { AiAuthError, AiRateLimitError, AiSchemaViolationError } from '../../src/ai-drafting/drafting-errors.js';
import type { StructuredDraftInput } from '../../src/ai-drafting/contract-drafting-provider.port.js';

const VALID = {
  clauses: [
    {
      title: 'Objet',
      text: 'Infogérance du SI de [CLIENT]. Voir https://www.legifrance.gouv.fr/x.',
      category: 'OBJET',
      riskLevel: 'LOW',
      justification: 'Articles 1162 et 1163 du Code civil.',
    },
  ],
  suggestedAnnexes: [{ title: 'Services', description: 'Périmètre.' }],
};

/** Double du SDK : aucun réseau. Enregistre les paramètres de `messages.parse`. */
function stubClient(result: unknown | (() => never)) {
  const calls: { params: Record<string, unknown>; options: unknown }[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>, options?: unknown) => {
        calls.push({ params, options });
        if (typeof result === 'function') return (result as () => never)();
        return result;
      },
    },
  } as unknown as AnthropicMessagesClient;
  return { client, calls };
}

const message = (parsed: unknown, over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  model: 'claude-opus-4-8',
  stop_reason: 'end_turn',
  content: [],
  parsed_output: parsed,
  usage: { input_tokens: 1200, output_tokens: 800 },
  ...over,
});

const INPUT: StructuredDraftInput = { contractType: 'Maintenance', needs: 'Maintenance de 20 postes pour [CLIENT].', services: ['Hotline'] };

describe('Claude — rédaction structurée (même port, même schéma)', () => {
  test('réponse validée, URL retirée du texte, aucune source, usage sans coût', async () => {
    const { client, calls } = stubClient(message(VALID));
    const r = await new ClaudeContractDrafter({ client }).draftStructured(INPUT);
    expect(r.provider).toBe('claude');
    expect(r.clauses[0]!.text).toBe('Infogérance du SI de [CLIENT]. Voir.');
    expect(r.clauses[0]!.removedUrls).toEqual(['https://www.legifrance.gouv.fr/x']);
    expect(r.sources).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 800 });
    expect(r.warnings.join()).toMatch(/sans recherche web/);
    expect(calls[0]!.params.model).toBe(CLAUDE_DEFAULT_MODEL);
    expect(String(calls[0]!.params.system)).toMatch(/Légifrance/);
    expect((r.raw.request as { output_schema: { name: string } }).output_schema.name).toBe('contract_draft_v1');
  });

  test('modèle du tenant respecté', async () => {
    const { client, calls } = stubClient(message(VALID));
    await new ClaudeContractDrafter({ client }).draftStructured({ ...INPUT, selection: { model: 'claude-opus-5' } });
    expect(calls[0]!.params.model).toBe('claude-opus-5');
  });

  test('sortie non conforme au schéma → AiSchemaViolationError (revalidation locale)', async () => {
    const { client } = stubClient(message({ clauses: [{ title: 'x' }], suggestedAnnexes: [] }));
    await expect(new ClaudeContractDrafter({ client }).draftStructured(INPUT)).rejects.toBeInstanceOf(AiSchemaViolationError);
  });

  test('génération tronquée ou refus → AiSchemaViolationError, pas de brouillon partiel', async () => {
    for (const stop of ['max_tokens', 'refusal']) {
      const { client } = stubClient(message(VALID, { stop_reason: stop }));
      await expect(new ClaudeContractDrafter({ client }).draftStructured(INPUT)).rejects.toBeInstanceOf(AiSchemaViolationError);
    }
  });

  test('erreurs du SDK mappées sur les erreurs typées', async () => {
    const withStatus = (status: number) => () => {
      throw Object.assign(new Error(`${status}`), { status });
    };
    await expect(new ClaudeContractDrafter({ client: stubClient(withStatus(401)).client }).draftStructured(INPUT)).rejects.toBeInstanceOf(AiAuthError);
    await expect(new ClaudeContractDrafter({ client: stubClient(withStatus(429)).client }).draftStructured(INPUT)).rejects.toBeInstanceOf(AiRateLimitError);
  });

  test('garde-fou de pseudonymisation aussi côté Claude', async () => {
    const { client, calls } = stubClient(message(VALID));
    await expect(
      new ClaudeContractDrafter({ client }).draftStructured({ ...INPUT, needs: 'Pour Acme', knownEntities: { clientNames: ['Acme'] } }),
    ).rejects.toBeInstanceOf(PseudonymizationLeakError);
    expect(calls).toHaveLength(0);
  });

  test('l’ancien port draft() reste disponible', async () => {
    const { client } = stubClient(message({ bodyHtml: '<p>{{client_nom}}</p>', suggestedVariables: ['client_nom'] }));
    const r = await new ClaudeContractDrafter({ client }).draft({ prompt: 'Un contrat' });
    expect(r.bodyHtml).toBe('<p>{{client_nom}}</p>');
  });
});
