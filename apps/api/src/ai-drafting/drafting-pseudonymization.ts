import { pseudonymize, reidentify, type KnownEntities, type PseudonymizationMap } from '@lsi/domain';
import type { StructuredDraftInput, TemplateClauseInput } from './contract-drafting-provider.port.js';

/**
 * Colle entre la pseudonymisation (pure, @lsi/domain) et le port structuré.
 *
 * Parcours type côté service :
 *
 *   const { input, map } = pseudonymizeDraftInput(raw, knownEntitiesDuClient);
 *   const result = await provider.draftStructured(input);   // garde-fou inclus
 *   const draft = reidentifyDeep({ clauses: result.clauses, suggestedAnnexes: result.suggestedAnnexes }, map);
 *   // archiver result.raw (texte PSEUDONYMISÉ) + la table `map` chiffrée à part, jamais ensemble en clair
 *
 * Tous les champs partagent UNE table : « Acme » est `[CLIENT]` dans le besoin
 * comme dans les clauses du contrat type.
 */

export interface RawDraftInput {
  readonly contractType: string;
  readonly needs: string;
  readonly services: readonly string[];
  readonly templateClauses?: readonly TemplateClauseInput[];
}

export function pseudonymizeDraftInput(
  raw: RawDraftInput,
  knownEntities: KnownEntities,
  selection?: StructuredDraftInput['selection'],
): { input: StructuredDraftInput; map: PseudonymizationMap } {
  let map: PseudonymizationMap = {};
  const p = (text: string): string => {
    const r = pseudonymize(text, knownEntities, { map });
    map = r.map;
    return r.text;
  };
  const input: StructuredDraftInput = {
    contractType: p(raw.contractType),
    needs: p(raw.needs),
    services: raw.services.map(p),
    ...(raw.templateClauses
      ? { templateClauses: raw.templateClauses.map((c) => ({ ...c, title: p(c.title), text: p(c.text) })) }
      : {}),
    knownEntities,
    ...(selection ? { selection } : {}),
  };
  return { input, map };
}

/** Réinjecte les valeurs réelles dans toutes les chaînes d'une structure (clauses, annexes…). */
export function reidentifyDeep<T>(value: T, map: PseudonymizationMap): T {
  if (typeof value === 'string') return reidentify(value, map) as T;
  if (Array.isArray(value)) return value.map((v) => reidentifyDeep(v, map)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = reidentifyDeep(v, map);
    return out as T;
  }
  return value;
}
