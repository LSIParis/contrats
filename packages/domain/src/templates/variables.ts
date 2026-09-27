import { z } from 'zod';

/**
 * Variables typées des contrats types (brief §4) : `{{client.raisonSociale}}`,
 * `{{contrat.dureeMois}}`, `{{sla.delaiIntervention}}`…
 *
 * Un REGISTRE fixe le sens et le type de chaque variable : une variable
 * inconnue est refusée, sauf si le modèle la déclare explicitement avec son
 * type. Sans cela, une faute de frappe (`{{client.raisonsociale}}`) finirait
 * dans un contrat signé sous la forme d'un trou.
 *
 * Le rendu ÉCHAPPE les valeurs : une raison sociale contenant du HTML ne
 * devient jamais du balisage dans le document signé.
 */
export type VariableType = 'string' | 'text' | 'date' | 'integer' | 'siren' | 'money';

export interface VariableDef {
  readonly label: string;
  readonly type: VariableType;
}

export const VARIABLE_REGISTRY: Readonly<Record<string, VariableDef>> = {
  'client.raisonSociale': { label: 'Raison sociale du client', type: 'string' },
  'client.siren': { label: 'SIREN du client', type: 'siren' },
  'client.tva': { label: 'N° de TVA intracommunautaire du client', type: 'string' },
  'client.adresse': { label: 'Adresse du siège du client', type: 'text' },
  'client.representant': { label: 'Représentant du client (nom, qualité)', type: 'string' },
  'prestataire.raisonSociale': { label: 'Raison sociale du prestataire', type: 'string' },
  'prestataire.siren': { label: 'SIREN du prestataire', type: 'siren' },
  'prestataire.adresse': { label: 'Adresse du prestataire', type: 'text' },
  'contrat.reference': { label: 'Référence du contrat', type: 'string' },
  'contrat.dateEffet': { label: 'Date d’effet', type: 'date' },
  'contrat.dureeMois': { label: 'Durée initiale (mois)', type: 'integer' },
  'contrat.preavis': { label: 'Préavis de dénonciation', type: 'string' },
  'contrat.reconduction': { label: 'Modalités de reconduction', type: 'string' },
  'sla.delaiIntervention': { label: 'Délai d’intervention', type: 'string' },
  'sla.delaiRetablissement': { label: 'Délai de rétablissement', type: 'string' },
  'sla.plageHoraire': { label: 'Plage horaire couverte', type: 'string' },
  'sla.tauxDisponibilite': { label: 'Taux de disponibilité', type: 'string' },
  'tarif.montantMensuelHt': { label: 'Montant mensuel HT (€)', type: 'money' },
};

const SCHEMAS: Record<VariableType, z.ZodType> = {
  string: z.string().trim().min(1).max(300),
  text: z.string().trim().min(1).max(2000),
  date: z.iso.date(),
  integer: z.coerce.number().int().min(0).max(1_000_000),
  siren: z.string().regex(/^\d{9}$/, 'SIREN : 9 chiffres'),
  // Montant en euros, décimal à 2 chiffres au plus, transmis en chaîne ou nombre.
  money: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'montant invalide')),
};

const VAR_RE = /\{\{\s*([A-Za-z][\w]*(?:\.[\w]+)*)\s*\}\}/g;

export function extractVariables(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(VAR_RE)) names.add(m[1]!);
  return [...names].sort();
}

export interface VariablesValidation {
  readonly ok: boolean;
  readonly values: Record<string, unknown>;
  readonly missing: string[];
  readonly unknown: string[];
  readonly invalid: { name: string; message: string }[];
}

/**
 * Valide les valeurs des variables `names` utilisées par un document.
 * `custom` : variables déclarées par le modèle hors registre (nom → type).
 */
export function validateVariables(
  names: readonly string[],
  values: Readonly<Record<string, unknown>>,
  custom: Readonly<Record<string, VariableType>> = {},
): VariablesValidation {
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  const unknown: string[] = [];
  const invalid: { name: string; message: string }[] = [];
  for (const name of names) {
    const type = VARIABLE_REGISTRY[name]?.type ?? custom[name];
    if (!type) {
      unknown.push(name);
      continue;
    }
    const raw = values[name];
    if (raw === undefined || raw === null || raw === '') {
      missing.push(name);
      continue;
    }
    const r = SCHEMAS[type].safeParse(raw);
    if (r.success) out[name] = r.data;
    else invalid.push({ name, message: r.error.issues[0]?.message ?? 'valeur invalide' });
  }
  return { ok: !missing.length && !unknown.length && !invalid.length, values: out, missing, unknown, invalid };
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function formatDateFr(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Substitue les variables. Une variable sans valeur devient un marqueur
 * visible `[à compléter : nom]` (jamais une chaîne vide silencieuse) et est
 * listée dans `missing` — la soumission en revue interne l'exige complète.
 */
export function renderVariables(html: string, values: Readonly<Record<string, unknown>>): { html: string; missing: string[] } {
  const missing = new Set<string>();
  const rendered = html.replace(VAR_RE, (_m, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === '') {
      missing.add(name);
      return `<mark>[à compléter : ${escapeHtml(name)}]</mark>`;
    }
    const type = VARIABLE_REGISTRY[name]?.type;
    const text = type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateFr(v) : String(v);
    return escapeHtml(text);
  });
  return { html: rendered, missing: [...missing].sort() };
}
