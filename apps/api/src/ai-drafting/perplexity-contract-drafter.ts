import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelSelection, ProviderUsage } from './contract-drafting-provider.port.js';
import {
  AiAuthError,
  AiBadRequestError,
  AiNotConfiguredError,
  AiRateLimitError,
  AiSchemaViolationError,
  AiTimeoutError,
  AiUpstreamError,
} from './drafting-errors.js';
import type { StructuredTask } from './drafting-prompts.js';
import { extractPerplexitySources } from './drafting-sources.js';
import { StructuredDraftingBase, type RawStructuredResult } from './structured-drafting-base.js';

/**
 * Adaptateur Perplexity **Agent API** (brief §6) — `POST {base}/v1/agent`.
 *
 * Contrat HTTP vérifié le 2026-09-26 sur la référence OpenAPI
 * (https://docs.perplexity.ai/api-reference/agent-post) et les guides
 * « Output Control » / « Web Search » / « Fetch URL » ; détail dans
 * `docs/contrats/05-ia-perplexity.md`. L'ancienne API Sonar Chat Completions
 * n'est PAS utilisée.
 *
 * `fetch` natif, pas de SDK (hypothèse V2-H7) : les fixtures sont des corps
 * HTTP rejouables tels quels, et l'adaptateur ne dépend pas de la forme
 * interne d'un SDK.
 *
 * Aucun nom de modèle n'est codé en dur : `model` et/ou `preset` viennent des
 * paramètres du tenant, à chaque appel (ou d'un défaut injecté à la
 * construction). Sans l'un ni l'autre, l'appel est refusé AVANT le réseau.
 */

export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai';

/**
 * Domaines autorisés pour `web_search` (`filters.search_domain_filter`, 20 max,
 * mode liste blanche) : sources juridiques et institutionnelles françaises.
 */
export const FRENCH_LEGAL_DOMAINS: readonly string[] = [
  'legifrance.gouv.fr',
  'cnil.fr',
  'cyber.gouv.fr',
  'ssi.gouv.fr',
  'service-public.fr',
  'entreprendre.service-public.fr',
  'economie.gouv.fr',
  'courdecassation.fr',
  'conseil-etat.fr',
  'eur-lex.europa.eu',
  'edpb.europa.eu',
];

export interface PerplexityDrafterOptions {
  readonly apiKey: string;
  /** `PERPLEXITY_BASE_URL`, défaut `https://api.perplexity.ai`. */
  readonly baseUrl?: string;
  /** Sélection par défaut si l'appel n'en fournit pas (paramètres du tenant). */
  readonly defaultSelection?: ModelSelection;
  /** Délai d'un appel ordinaire. Défaut 60 s. */
  readonly timeoutMs?: number;
  /**
   * Délai du PREMIER appel d'un schéma encore jamais vu par ce processus.
   * La documentation annonce 10 à 30 s de préparation d'un nouveau schéma,
   * « pouvant provoquer des timeouts ». Défaut 120 s.
   */
  readonly firstSchemaTimeoutMs?: number;
  /** Obligatoire côté Perplexity pour les modèles `anthropic/*`. Défaut 8192. */
  readonly maxOutputTokens?: number;
  /** Liste blanche de domaines pour `web_search` ; `null` = pas de filtre. */
  readonly searchDomainFilter?: readonly string[] | null;
  /** Injection pour les tests (aucun réseau réel en CI). */
  readonly fetch?: typeof fetch;
}

/** Enveloppe de réponse : validée souplement (champs inconnus tolérés), le contenu l'est strictement ensuite. */
const ResponseEnvelope = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.string(),
  output: z.array(z.looseObject({ type: z.string() })),
  error: z.looseObject({ message: z.string().optional(), code: z.string().optional() }).nullish(),
  usage: z
    .looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cost: z.looseObject({ total_cost: z.number().nullish() }).nullish(),
      tool_calls_details: z.record(z.string(), z.looseObject({ invocation: z.number().nullish() })).nullish(),
    })
    .nullish(),
});
type Envelope = z.infer<typeof ResponseEnvelope>;

const ErrorBody = z.looseObject({ error: z.looseObject({ message: z.string().optional(), type: z.string().optional() }).optional() });

/** Sérialisation à clés triées : deux schémas identiques ont la même empreinte. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function schemaHash(schema: unknown): string {
  return createHash('sha256').update(stableStringify(schema)).digest('hex').slice(0, 16);
}

function upstreamMessage(bodyText: string): string {
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(bodyText));
    const msg = parsed.success ? parsed.data.error?.message : undefined;
    if (msg) return msg.slice(0, 300);
  } catch {
    /* corps non JSON */
  }
  return bodyText.slice(0, 300);
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, Math.round((d - Date.now()) / 1000));
}

/** Texte du DERNIER message assistant (`output_text`), là où arrive le JSON structuré. */
function outputText(env: Envelope): string | null {
  const messages = env.output.filter((o) => o.type === 'message');
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  if (!last || !Array.isArray(last.content)) return null;
  const texts = (last.content as { type?: unknown; text?: unknown }[])
    .filter((p) => p?.type === 'output_text' && typeof p.text === 'string')
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join('') : null;
}

function usageOf(env: Envelope): ProviderUsage {
  const u = env.usage;
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  const tools: Record<string, number> = {};
  for (const [k, v] of Object.entries(u.tool_calls_details ?? {})) if (typeof v.invocation === 'number') tools[k] = v.invocation;
  const cost = u.cost?.total_cost;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
    ...(Object.keys(tools).length > 0 ? { toolInvocations: tools } : {}),
  };
}

export class PerplexityContractDrafter extends StructuredDraftingBase {
  readonly name = 'perplexity' as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly firstSchemaTimeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly domainFilter: readonly string[] | null;
  private readonly fetchImpl: typeof fetch;
  /** Empreintes des schémas déjà acceptés par l'API depuis le démarrage du processus. */
  private readonly seenSchemas = new Set<string>();

  constructor(private readonly options: PerplexityDrafterOptions) {
    super();
    if (!options.apiKey) throw new AiNotConfiguredError('Perplexity : PERPLEXITY_API_KEY absente.', 'perplexity');
    this.baseUrl = (options.baseUrl || PERPLEXITY_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.firstSchemaTimeoutMs = options.firstSchemaTimeoutMs ?? 120_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 8192;
    this.domainFilter = options.searchDomainFilter === undefined ? FRENCH_LEGAL_DOMAINS : options.searchDomainFilter;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Vrai si ce schéma a déjà été accepté (le prochain appel aura le délai court). Exposé pour les tests. */
  hasSeenSchema(jsonSchema: unknown): boolean {
    return this.seenSchemas.has(schemaHash(jsonSchema));
  }

  /** Corps de requête `POST /v1/agent`. Public pour l'archivage et les tests. */
  buildRequestBody(task: StructuredTask<unknown>, selection: ModelSelection): Record<string, unknown> {
    const tools: Record<string, unknown>[] = [];
    if (task.webSearch) {
      tools.push({
        type: 'web_search',
        ...(this.domainFilter && this.domainFilter.length > 0 ? { filters: { search_domain_filter: [...this.domainFilter].slice(0, 20) } } : {}),
      });
      tools.push({ type: 'fetch_url' });
    }
    return {
      ...(selection.preset ? { preset: selection.preset } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      instructions: task.instructions,
      input: task.input,
      ...(tools.length > 0 ? { tools } : {}),
      response_format: {
        type: 'json_schema',
        json_schema: { name: task.schemaName, schema: task.jsonSchema, strict: true },
      },
      language_preference: 'fr',
      max_output_tokens: this.maxOutputTokens,
      // Pas de conservation côté fournisseur pour une relecture ultérieure : l'archive d'audit est chez nous.
      store: false,
      stream: false,
    };
  }

  protected async runStructured<T>(task: StructuredTask<T>, selection: ModelSelection | undefined): Promise<RawStructuredResult<T>> {
    const sel = selection ?? this.options.defaultSelection;
    if (!sel || (!sel.model && !sel.preset)) {
      throw new AiNotConfiguredError('Perplexity : ni « model » ni « preset » configuré pour ce tenant.', 'perplexity');
    }
    const body = this.buildRequestBody(task as StructuredTask<unknown>, sel);
    const hash = schemaHash(task.jsonSchema);
    const timeout = this.seenSchemas.has(hash) ? this.timeoutMs : this.firstSchemaTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/agent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      // La lecture du corps est couverte par le même délai.
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AiTimeoutError(`Perplexity : pas de réponse en ${Math.round(timeout / 1000)} s.`, 'perplexity', timeout, { cause: err });
      }
      throw new AiUpstreamError('Perplexity : erreur réseau.', 'perplexity', undefined, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (status === 401 || status === 403) throw new AiAuthError(`Perplexity ${status} : ${upstreamMessage(text)}`, 'perplexity', status);
    if (status === 400 || status === 422) throw new AiBadRequestError(`Perplexity ${status} : ${upstreamMessage(text)}`, 'perplexity', status);
    if (status === 429) throw new AiRateLimitError(`Perplexity 429 : ${upstreamMessage(text)}`, 'perplexity', parseRetryAfter(retryAfter));
    if (status < 200 || status >= 300) throw new AiUpstreamError(`Perplexity ${status} : ${upstreamMessage(text)}`, 'perplexity', status);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new AiSchemaViolationError('Perplexity : corps de réponse non JSON.', 'perplexity', [], { cause: err });
    }
    const env = ResponseEnvelope.safeParse(json);
    if (!env.success) {
      throw new AiSchemaViolationError('Perplexity : enveloppe de réponse inattendue.', 'perplexity', env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    }
    // L'API a accepté (et donc préparé) le schéma : les appels suivants auront le délai court.
    this.seenSchemas.add(hash);

    const e = env.data;
    if (e.status === 'failed') throw new AiUpstreamError(`Perplexity : génération en échec (${e.error?.message ?? 'sans détail'}).`, 'perplexity');
    if (e.status === 'incomplete') throw new AiSchemaViolationError('Perplexity : génération incomplète (limite de jetons ?), aucun brouillon partiel.', 'perplexity');
    if (e.status !== 'completed') throw new AiUpstreamError(`Perplexity : statut inattendu « ${e.status} ».`, 'perplexity');

    const out = outputText(e);
    if (out === null) throw new AiSchemaViolationError('Perplexity : aucun message dans la réponse.', 'perplexity');
    let parsed: unknown;
    try {
      // Tolérance unique : une clôture ```json autour d'un JSON par ailleurs complet.
      parsed = JSON.parse(out.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
    } catch (err) {
      throw new AiSchemaViolationError('Perplexity : la sortie n’est pas un JSON valide.', 'perplexity', [], { cause: err });
    }
    const valid = task.schema.safeParse(parsed);
    if (!valid.success) {
      throw new AiSchemaViolationError(
        'Perplexity : sortie non conforme au schéma, aucun brouillon créé.',
        'perplexity',
        valid.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const sources = extractPerplexitySources(e.output);
    const warnings: string[] = [];
    if (task.webSearch && sources.length === 0) warnings.push('Aucune source renvoyée par la recherche web : justifications non étayées, à vérifier.');
    return {
      data: valid.data,
      sources,
      usage: usageOf(e),
      ...(e.model ? { model: e.model } : {}),
      warnings,
      raw: { request: body, response: json },
    };
  }
}
