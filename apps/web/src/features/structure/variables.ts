import type { VariableDef } from './structure-api.js';

/**
 * Variables `{{client.raisonSociale}}` du document — même motif que le domaine
 * (packages/domain/src/templates/variables.ts). L'API ne renvoie que le
 * NOMBRE de variables manquantes : l'interface recalcule lesquelles, pour les
 * surligner dans le panneau.
 */
const VAR_RE = /\{\{\s*([A-Za-z][\w]*(?:\.[\w]+)*)\s*\}\}/g;

export function extractVariables(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(VAR_RE)) names.add(m[1]!);
  return [...names].sort();
}

export function usedVariables(parts: readonly { bodyHtml?: string | null }[]): string[] {
  return [...new Set(parts.flatMap((p) => extractVariables(p.bodyHtml ?? '')))].sort();
}

export const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export interface VariableRow {
  name: string;
  label: string;
  type: string;
  value: string;
  missing: boolean;
  /** Ni dans le registre ni déclarée par le modèle : l'API refusera l'enregistrement. */
  unknown: boolean;
}

export function variableRows(
  names: readonly string[],
  values: Readonly<Record<string, unknown>>,
  definitions: Readonly<Record<string, VariableDef>>,
  custom: Readonly<Record<string, string>> = {},
): VariableRow[] {
  return names.map((name) => {
    const def = definitions[name];
    const type = def?.type ?? custom[name];
    const raw = values[name];
    return {
      name,
      label: def?.label ?? name,
      type: type ?? 'string',
      value: isBlank(raw) ? '' : String(raw),
      missing: isBlank(raw),
      unknown: !type,
    };
  });
}
