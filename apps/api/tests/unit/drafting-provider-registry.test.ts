import { describe, test, expect } from 'vitest';
import { DraftingProviderRegistry } from '../../src/ai-drafting/drafting-provider-registry.js';
import { PerplexityContractDrafter } from '../../src/ai-drafting/perplexity-contract-drafter.js';
import { ClaudeContractDrafter } from '../../src/ai-drafting/claude-contract-drafter.js';
import { UnavailableDraftingProvider } from '../../src/ai-drafting/unavailable-contract-drafter.js';
import { AiNotConfiguredError } from '../../src/ai-drafting/drafting-errors.js';
import type { ContractDraftingProvider } from '../../src/ai-drafting/contract-drafting-provider.port.js';

// Fabrique Claude factice : `new Anthropic()` n'a rien à faire dans un test de registre.
const fakeClaude = () => ({ name: 'claude' }) as unknown as ContractDraftingProvider;

describe('DraftingProviderRegistry', () => {
  test('aucune clé : seul « unavailable », et il lève AiNotConfiguredError', async () => {
    const reg = new DraftingProviderRegistry({});
    expect(reg.available()).toEqual(['unavailable']);
    const p = reg.resolve();
    expect(p).toBeInstanceOf(UnavailableDraftingProvider);
    await expect(p.draftStructured({ contractType: 'x', needs: 'y', services: [] })).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  test('clé Perplexity : Perplexity par défaut, base URL et délais lus dans l’env', () => {
    const reg = new DraftingProviderRegistry({
      PERPLEXITY_API_KEY: 'pplx-k',
      PERPLEXITY_BASE_URL: 'https://proxy.example',
      PERPLEXITY_TIMEOUT_MS: '30000',
      PERPLEXITY_FIRST_SCHEMA_TIMEOUT_MS: 'abc',
    });
    expect(reg.available()).toEqual(['perplexity', 'unavailable']);
    const p = reg.resolve();
    expect(p).toBeInstanceOf(PerplexityContractDrafter);
    expect(p.name).toBe('perplexity');
  });

  test('deux clés : Perplexity préféré par défaut, Claude sur demande du tenant', () => {
    const reg = new DraftingProviderRegistry({ PERPLEXITY_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, { claude: fakeClaude });
    expect(reg.available()).toEqual(['perplexity', 'claude', 'unavailable']);
    expect(reg.resolve().name).toBe('perplexity');
    expect(reg.resolve('claude').name).toBe('claude');
  });

  test('clé Anthropic seule : Claude', () => {
    const reg = new DraftingProviderRegistry({ ANTHROPIC_API_KEY: 'a' }, { claude: fakeClaude });
    expect(reg.resolve().name).toBe('claude');
  });

  test('fournisseur demandé mais non configuré : indisponible, JAMAIS de repli silencieux vers un autre', async () => {
    const reg = new DraftingProviderRegistry({ PERPLEXITY_API_KEY: 'k' });
    const p = reg.resolve('claude');
    expect(p.name).toBe('unavailable');
    await expect(p.explainClause({ clause: { title: 't', text: 'x' } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test('clé vide ou blanche = absente', () => {
    expect(new DraftingProviderRegistry({ PERPLEXITY_API_KEY: '  ' }).isConfigured('perplexity')).toBe(false);
  });

  test('instances mises en cache (mémoire des schémas préparés)', () => {
    const reg = new DraftingProviderRegistry({ PERPLEXITY_API_KEY: 'k' });
    expect(reg.get('perplexity')).toBe(reg.get('perplexity'));
  });

  test('fabrique Claude par défaut : l’adaptateur réel', () => {
    const reg = new DraftingProviderRegistry({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(reg.get('claude')).toBeInstanceOf(ClaudeContractDrafter);
  });
});
