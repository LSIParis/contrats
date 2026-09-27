import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';

/** GET /v1/ai/availability (apps/api/src/ai-drafting/ai-gateway.service.ts). */
export interface AiAvailability {
  enabled: boolean;
  provider: string | null;
  configured: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  available: boolean;
}

export function useAiAvailability(enabled = true) {
  return useQuery({
    queryKey: ['ai-availability'],
    queryFn: () => apiGet<AiAvailability>('/v1/ai/availability'),
    enabled,
    staleTime: 60_000,
  });
}

const PROVIDER_FR: Record<string, string> = { perplexity: 'Perplexity', claude: 'Claude (Anthropic)', anthropic: 'Claude (Anthropic)' };
export const providerLabel = (p: string | null | undefined) => (p ? PROVIDER_FR[p.toLowerCase()] ?? p : 'le fournisseur configuré');

/** Pourquoi l'assistance IA est indisponible (null = disponible). */
export function aiUnavailableReason(a: AiAvailability | undefined): string | null {
  if (!a) return 'Disponibilité de l’assistance IA inconnue.';
  if (!a.enabled) return 'L’assistance IA est désactivée pour votre organisation.';
  if (!a.configured) return `Aucun accès au fournisseur IA (${providerLabel(a.provider)}) n’est configuré : contactez un administrateur.`;
  if (a.budgetUsd !== null && a.spentUsd >= a.budgetUsd) {
    return `Budget IA du mois atteint (${a.spentUsd.toFixed(2)} / ${a.budgetUsd} USD).`;
  }
  return a.available ? null : 'L’assistance IA est momentanément indisponible.';
}

export interface AiSource { url: string; title?: string; snippet?: string }

export interface RephraseResult {
  action: 'rephrase' | 'harden';
  provider: string;
  sources: AiSource[];
  warnings: string[];
  changes: string[];
  suggestion: { title: string; bodyHtml: string; riskLevel: string; justification: string };
}
export interface ExplainResult {
  action: 'explain';
  provider: string;
  sources: AiSource[];
  warnings: string[];
  explanation: { summary: string; keyPoints: string[]; pointsOfAttention: string[] };
}
export interface CompareResult {
  action: 'compare';
  provider: string;
  sources: AiSource[];
  warnings: string[];
  comparison: {
    closestItemId: string;
    similarity: 'IDENTICAL' | 'EQUIVALENT' | 'DIVERGENT' | 'UNRELATED' | string;
    differences: { aspect: string; clause: string; library: string; riskLevel: string }[];
    recommendation: string;
  };
}
export type ClauseAiResult = RephraseResult | ExplainResult | CompareResult;

export interface MissingClausesResult {
  provider: string;
  sources: AiSource[];
  warnings: string[];
  missing: { title: string; category: string; reason: string; riskLevel: string }[];
}

export interface DraftResult {
  versionNumber: number;
  unreviewedAiClauses: number;
  provider: string;
  sources: AiSource[];
  warnings: string[];
  suggestedAnnexes: { title: string; description: string }[];
}

export const SIMILARITY_FR: Record<string, string> = {
  IDENTICAL: 'Identique à la bibliothèque',
  EQUIVALENT: 'Équivalente à la bibliothèque',
  DIVERGENT: 'Diverge de la bibliothèque',
  UNRELATED: 'Aucune clause comparable dans la bibliothèque',
};
