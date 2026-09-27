import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { PseudonymizationLeakError } from '@lsi/domain';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import type { AiCallResult, ContractDraftingProvider, ModelSelection } from './contract-drafting-provider.port.js';
import { AiDraftingError, toHttpException } from './drafting-errors.js';
import { DraftingProviderRegistry } from './drafting-provider-registry.js';

export const DRAFTING_REGISTRY = Symbol('DRAFTING_REGISTRY');

export type AiOperation =
  | 'DRAFT' | 'REPHRASE' | 'HARDEN' | 'EXPLAIN' | 'COMPARE' | 'MISSING' | 'IMPORT_EXTRACT'
  | 'PROPOSAL_DRAFT' | 'PROPOSAL_REPHRASE' | 'PROSPECT_RESEARCH';

export interface AiCallContext {
  readonly operation: AiOperation;
  readonly contractId?: string | null;
  readonly schemaName?: string;
}

/** Début du mois civil UTC de `now`. */
export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Point de passage UNIQUE vers un fournisseur IA (lot 6, 05-ia-perplexity §13).
 *
 * Avant l'appel : drapeau `contrats.ai.enabled` du tenant, fournisseur CHOISI
 * par le tenant (`ai.provider` — jamais de repli silencieux vers l'autre),
 * modèle/preset du tenant, plafond mensuel `ai.monthlyBudgetUsd`.
 * Après l'appel (réussi OU non) : une ligne `ai_usage` — jetons, coût,
 * durée, statut ; jamais de texte.
 */
@Injectable()
export class AiGateway {
  private readonly log = new Logger(AiGateway.name);

  constructor(
    private readonly config: TenantConfigService,
    @Inject(DRAFTING_REGISTRY) private readonly registry: DraftingProviderRegistry,
  ) {}

  /** État de l'assistance pour l'interface (bouton masqué ou expliqué). */
  async availability(scope: Scope, now: Date) {
    const [enabled, provider, budgetUsd, spentUsd] = await Promise.all([
      this.config.isEnabled(scope, 'contrats.ai.enabled'),
      this.config.setting(scope, 'ai.provider'),
      this.config.setting(scope, 'ai.monthlyBudgetUsd'),
      this.spentThisMonth(scope, now),
    ]);
    const configured = this.registry.isConfigured(provider);
    return {
      enabled, provider, configured,
      budgetUsd, spentUsd,
      available: enabled && configured && (budgetUsd === null || spentUsd < budgetUsd),
    };
  }

  async call<T>(
    scope: Scope,
    ctx: AiCallContext,
    fn: (provider: ContractDraftingProvider, selection: ModelSelection | undefined) => Promise<AiCallResult<T>>,
    now: Date = new Date(),
  ): Promise<AiCallResult<T>> {
    if (!(await this.config.isEnabled(scope, 'contrats.ai.enabled'))) {
      throw new HttpException(
        { code: 'AI_DISABLED', detail: "L'assistance IA est désactivée pour votre organisation." },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const [preferred, model, preset, budget] = await Promise.all([
      this.config.setting(scope, 'ai.provider'),
      this.config.setting(scope, 'ai.model'),
      this.config.setting(scope, 'ai.preset'),
      this.config.setting(scope, 'ai.monthlyBudgetUsd'),
    ]);
    if (budget !== null) {
      const spent = await this.spentThisMonth(scope, now);
      if (spent >= budget) {
        throw new HttpException(
          { code: 'AI_BUDGET_EXCEEDED', detail: `Budget IA du mois atteint (${spent.toFixed(2)} / ${budget} USD).` },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    const provider = this.registry.resolve(preferred);
    const selection: ModelSelection | undefined =
      model || preset ? { ...(model ? { model } : {}), ...(preset ? { preset } : {}) } : undefined;

    const started = Date.now();
    try {
      const r = await fn(provider, selection);
      await this.record(scope, ctx, provider.name, 'OK', r, Date.now() - started, now);
      return r;
    } catch (e) {
      const status = e instanceof PseudonymizationLeakError ? 'LEAK_BLOCKED' : e instanceof AiDraftingError ? e.kind : 'UPSTREAM';
      await this.record(scope, ctx, provider.name, status, null, Date.now() - started, now);
      this.log.warn(`IA ${ctx.operation} en échec (${provider.name}, ${status}) : ${(e as Error).message}`);
      throw toHttpException(e);
    }
  }

  async spentThisMonth(scope: Scope, now: Date): Promise<number> {
    const agg = await withScope(scope, (tx) =>
      tx.aiUsage.aggregate({ where: { createdAt: { gte: monthStart(now) } }, _sum: { costUsd: true } }),
    );
    return Number(agg._sum.costUsd ?? 0);
  }

  /** Synthèse mensuelle pour l'administrateur (coût, jetons, appels par opération). */
  async usage(scope: Scope, month: Date) {
    const from = monthStart(month);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const rows = await withScope(scope, (tx) =>
      tx.aiUsage.groupBy({
        by: ['operation', 'provider', 'status'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      }),
    );
    const lines = rows.map((r) => ({
      operation: r.operation, provider: r.provider, status: r.status, calls: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0,
      costUsd: Number(r._sum.costUsd ?? 0),
    }));
    return {
      month: from.toISOString().slice(0, 7),
      totalCostUsd: Number(lines.reduce((s, l) => s + l.costUsd, 0).toFixed(6)),
      totalCalls: lines.reduce((s, l) => s + l.calls, 0),
      budgetUsd: await this.config.setting(scope, 'ai.monthlyBudgetUsd'),
      lines,
    };
  }

  private async record(
    scope: Scope, ctx: AiCallContext, provider: string, status: string,
    r: AiCallResult<unknown> | null, durationMs: number, now: Date,
  ) {
    try {
      await withScope(scope, (tx) => tx.aiUsage.create({
        data: {
          id: uuidv7(), tenantId: scope.tenantId, userId: scope.userId ?? null, contractId: ctx.contractId ?? null,
          operation: ctx.operation, provider, model: r?.model ?? null, schemaName: ctx.schemaName ?? null,
          status: status as never,
          inputTokens: r?.usage.inputTokens ?? 0, outputTokens: r?.usage.outputTokens ?? 0,
          costUsd: r?.usage.costUsd !== undefined ? r.usage.costUsd : null,
          toolInvocations: (r?.usage.toolInvocations ?? undefined) as never,
          durationMs, createdAt: now,
        },
      }));
    } catch (e) {
      // Le journal de coût ne doit jamais faire échouer l'appel métier.
      this.log.error(`ai_usage non enregistré : ${(e as Error).message}`);
    }
  }
}
