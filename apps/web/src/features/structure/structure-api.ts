import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../../lib/api.js';

/**
 * Contenu STRUCTURÉ d'un contrat (lot 2) : clauses, annexes, variables.
 * Contrat d'API : apps/api/src/structure/structure.service.ts (`get`, `save`,
 * `reviewClause`) — 01-domaine.md §6.
 */

export interface ClauseReview {
  decision: 'APPROVED' | 'REJECTED';
  by: string;
  at: string;
  comment: string | null;
}

export interface ClauseAiMeta {
  risk: string | null;
  justification: string | null;
  sources: unknown;
  review: ClauseReview | null;
}

export interface StructureClause {
  id: string;
  clauseKey: string;
  position: number;
  title: string;
  category: string;
  bodyHtml: string;
  origin: 'TEMPLATE' | 'LIBRARY' | 'CUSTOM' | 'AI' | string;
  sourceClauseVersionId: string | null;
  ai: ClauseAiMeta | null;
}

export interface StructureAnnex {
  id: string;
  position: number;
  kind: string;
  title: string;
  bodyHtml: string | null;
  data: Record<string, unknown> | null;
}

export interface VariableDef {
  label: string;
  type: 'string' | 'text' | 'date' | 'integer' | 'siren' | 'money' | string;
}

export interface ClauseDiff {
  added: { key: string; title: string }[];
  removed: { key: string; title: string; required: boolean }[];
  modified: { key: string; title: string; titleChanged: boolean; bodyChanged: boolean }[];
  hasDeviation: boolean;
  requiredRemoved: boolean;
}

export interface Structure {
  versionId: string | null;
  versionNumber?: number;
  clauses: StructureClause[];
  annexes: StructureAnnex[];
  variables: {
    values: Record<string, unknown>;
    custom?: Record<string, string>;
    /** Nombre de variables encore sans valeur (compteur du contrat). */
    missing: number | string[];
    definitions: Record<string, VariableDef>;
  };
  diff: ClauseDiff | null;
  unreviewedAiClauses?: number;
}

export interface SaveClause {
  clauseKey?: string;
  title: string;
  category: string;
  bodyHtml: string;
  origin: string;
  sourceClauseVersionId?: string | null;
}

/** Métadonnées d'une clause reprise d'une suggestion IA (sinon conservées par le serveur). */
export interface AiSaveMeta {
  risk: string;
  justification: string;
  sources: { url: string; title: string }[];
}

export interface SaveAnnex {
  kind: string;
  title: string;
  bodyHtml?: string | null;
  data?: Record<string, unknown> | null;
}

export interface SaveStructurePayload {
  clauses: (SaveClause & { ai?: AiSaveMeta })[];
  annexes: SaveAnnex[];
  variables: Record<string, unknown>;
  changeSummary?: string;
}

export interface SaveResult {
  id: string;
  status: string;
  missingVariables: number;
  unreviewedAiClauses: number;
  versionId: string;
  versionNumber: number;
}

export const structureKey = (contractId: string) => ['structure', contractId] as const;

export function useStructure(contractId: string | undefined) {
  return useQuery({
    queryKey: structureKey(contractId ?? ''),
    queryFn: () => apiGet<Structure>(`/v1/contracts/${contractId}/structure`),
    enabled: !!contractId,
  });
}

/** Invalide tout ce qu'une nouvelle version du contenu peut changer. */
export function invalidateContent(qc: ReturnType<typeof useQueryClient>, contractId: string) {
  for (const key of [structureKey(contractId), ['contract', contractId], ['allowed-actions', contractId], ['versions', contractId], ['lifecycle', contractId]]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** Clause courante → clause à enregistrer (les métadonnées IA restent côté serveur). */
export function toSaveClause(c: StructureClause): SaveClause {
  return {
    clauseKey: c.clauseKey,
    title: c.title,
    category: c.category,
    bodyHtml: c.bodyHtml,
    origin: c.origin,
    sourceClauseVersionId: c.sourceClauseVersionId,
  };
}

export function toSaveAnnex(a: StructureAnnex): SaveAnnex {
  return { kind: a.kind, title: a.title, bodyHtml: a.bodyHtml, data: a.data };
}

/**
 * Enregistrement de la structure courante avec UNE clause remplacée (suggestion
 * IA reprise par l'utilisateur) : même route que l'éditeur, origine AI.
 */
export function replaceClausePayload(
  s: Structure,
  clauseKey: string,
  next: { title: string; bodyHtml: string; ai?: AiSaveMeta },
  changeSummary: string,
): SaveStructurePayload {
  return {
    clauses: s.clauses.map((c) =>
      c.clauseKey === clauseKey
        ? { ...toSaveClause(c), title: next.title, bodyHtml: next.bodyHtml, origin: 'AI', sourceClauseVersionId: null, ...(next.ai ? { ai: next.ai } : {}) }
        : toSaveClause(c),
    ),
    annexes: s.annexes.map(toSaveAnnex),
    variables: {},
    changeSummary,
  };
}

export function useSaveStructure(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SaveStructurePayload) => apiPut<SaveResult>(`/v1/contracts/${contractId}/structure`, payload),
    onSuccess: () => invalidateContent(qc, contractId),
  });
}

export function useReviewClause(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { clauseId: string; decision: 'APPROVED' | 'REJECTED'; comment?: string }) =>
      apiPost<{ clauseId: string; decision: string; unreviewedAiClauses: number }>(
        `/v1/contracts/${contractId}/clauses/${v.clauseId}/review`,
        { decision: v.decision, ...(v.comment?.trim() ? { comment: v.comment.trim() } : {}) },
      ),
    onSuccess: () => invalidateContent(qc, contractId),
  });
}

/** Sources IA (JSON libre côté base) → liste affichable, sans jamais inventer de lien. */
export function aiSourceList(sources: unknown): { url: string; title: string }[] {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s): s is { url: string; title?: string } => !!s && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string')
    .filter((s) => /^https?:\/\//i.test(s.url))
    .map((s) => ({ url: s.url, title: typeof s.title === 'string' && s.title.trim() ? s.title : s.url }));
}
