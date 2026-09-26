import { ClaudeContractDrafter } from './claude-contract-drafter.js';
import type { ContractDraftingProvider, DraftingProviderName } from './contract-drafting-provider.port.js';
import { PerplexityContractDrafter } from './perplexity-contract-drafter.js';
import { UnavailableDraftingProvider } from './unavailable-contract-drafter.js';

/**
 * Registre des fournisseurs de rédaction structurée.
 *
 * Classe simple, SANS dépendance Nest : le câblage dans `app.module` (et le
 * choix par tenant, `contrats.ai.provider` / `contrats.ai.enabled`) est fait
 * par l'appelant. Le registre ne sait qu'une chose : quelles clés sont
 * présentes, donc quels fournisseurs sont UTILISABLES.
 *
 * Les instances sont mises en cache : l'adaptateur Perplexity mémorise les
 * schémas déjà préparés côté API (délai long seulement au premier appel), ce
 * qui n'a de sens que si l'instance vit aussi longtemps que le processus.
 */

export interface DraftingEnv {
  readonly PERPLEXITY_API_KEY?: string | undefined;
  readonly PERPLEXITY_BASE_URL?: string | undefined;
  readonly PERPLEXITY_TIMEOUT_MS?: string | undefined;
  readonly PERPLEXITY_FIRST_SCHEMA_TIMEOUT_MS?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
}

export type DraftingProviderFactories = {
  readonly [K in Exclude<DraftingProviderName, 'unavailable'>]?: (env: DraftingEnv) => ContractDraftingProvider;
};

/** Ordre de préférence quand le tenant n'exprime pas de choix : Perplexity est le défaut du brief. */
export const DEFAULT_PROVIDER_ORDER: readonly Exclude<DraftingProviderName, 'unavailable'>[] = ['perplexity', 'claude'];

const positiveInt = (v: string | undefined): number | undefined => {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const DEFAULT_FACTORIES: Required<DraftingProviderFactories> = {
  perplexity: (env) => {
    const timeoutMs = positiveInt(env.PERPLEXITY_TIMEOUT_MS);
    const firstSchemaTimeoutMs = positiveInt(env.PERPLEXITY_FIRST_SCHEMA_TIMEOUT_MS);
    return new PerplexityContractDrafter({
      apiKey: env.PERPLEXITY_API_KEY ?? '',
      ...(env.PERPLEXITY_BASE_URL ? { baseUrl: env.PERPLEXITY_BASE_URL } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(firstSchemaTimeoutMs ? { firstSchemaTimeoutMs } : {}),
    });
  },
  claude: () => new ClaudeContractDrafter(),
};

const KEY_OF: Record<Exclude<DraftingProviderName, 'unavailable'>, keyof DraftingEnv> = {
  perplexity: 'PERPLEXITY_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
};

export class DraftingProviderRegistry {
  private readonly cache = new Map<DraftingProviderName, ContractDraftingProvider>();
  private readonly factories: Required<DraftingProviderFactories>;

  constructor(
    private readonly env: DraftingEnv = process.env,
    factories: DraftingProviderFactories = {},
  ) {
    this.factories = { ...DEFAULT_FACTORIES, ...factories };
  }

  /** Vrai si la clé du fournisseur est présente (non vide). `unavailable` l'est toujours. */
  isConfigured(name: DraftingProviderName): boolean {
    if (name === 'unavailable') return true;
    return Boolean(this.env[KEY_OF[name]]?.trim());
  }

  /** Fournisseurs utilisables, dans l'ordre de préférence, `unavailable` en dernier. */
  available(): DraftingProviderName[] {
    return [...DEFAULT_PROVIDER_ORDER.filter((n) => this.isConfigured(n)), 'unavailable'];
  }

  /**
   * Fournisseur demandé. S'il n'est pas configuré, renvoie un fournisseur
   * « indisponible » qui explique pourquoi — jamais un repli silencieux vers
   * un autre fournisseur (le tenant a pu choisir Claude pour une raison
   * contractuelle ; lui substituer Perplexity serait un transfert non consenti).
   */
  get(name: DraftingProviderName): ContractDraftingProvider {
    const cached = this.cache.get(name);
    if (cached) return cached;
    let provider: ContractDraftingProvider;
    if (name === 'unavailable') provider = new UnavailableDraftingProvider();
    else if (!this.isConfigured(name)) {
      // Pas mis en cache : la clé peut être ajoutée par un redémarrage, pas à chaud, mais on reste simple.
      return new UnavailableDraftingProvider(`Assistance IA « ${name} » non configurée (${KEY_OF[name]} absente).`);
    } else provider = this.factories[name](this.env);
    this.cache.set(name, provider);
    return provider;
  }

  /**
   * Choix effectif : le fournisseur préféré du tenant s'il est nommé (même
   * non configuré → indisponible, cf. `get`), sinon le premier configuré dans
   * l'ordre par défaut, sinon « indisponible ».
   */
  resolve(preferred?: DraftingProviderName | null): ContractDraftingProvider {
    if (preferred) return this.get(preferred);
    const first = DEFAULT_PROVIDER_ORDER.find((n) => this.isConfigured(n));
    return this.get(first ?? 'unavailable');
  }
}
