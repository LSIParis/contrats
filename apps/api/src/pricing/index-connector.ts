/**
 * Connecteurs d'import de valeurs d'indice (brief §5 : « saisies ou importées
 * par un connecteur configurable ; aucune valeur n'est codée en dur »).
 *
 * Un connecteur TRADUIT une source (fichier, plus tard une API publique type
 * INSEE) en lignes normalisées ; il ne décide de rien : la validation métier
 * (période déjà publiée, correction explicite) est faite par
 * PriceIndexesService, identique pour la saisie manuelle et l'import. Aucun
 * connecteur n'ouvre le réseau dans cette version.
 *
 * Paramétrage par série : `price_indexes.connector` (JSON, jamais de secret),
 * ex. `{ "type": "CSV", "delimiter": ";", "decimalComma": true }`.
 */

export interface IndexImportRow {
  /** Numéro de ligne dans la source (1 = première ligne du fichier). */
  readonly line: number;
  readonly period: string;
  readonly value: string;
  /** « YYYY-MM-DD » ; null si la source ne la fournit pas. */
  readonly publishedAt: string | null;
}

export interface IndexImportError {
  readonly line: number;
  readonly message: string;
}

export interface IndexImportParseResult {
  readonly rows: IndexImportRow[];
  readonly errors: IndexImportError[];
}

export interface IndexConnector {
  /** Valeur de `connector.type` servie par cet adaptateur. */
  readonly type: string;
  parse(content: Buffer, config: Readonly<Record<string, unknown>> | null): IndexImportParseResult;
}

export const INDEX_CONNECTORS = Symbol('INDEX_CONNECTORS');

export const MAX_IMPORT_ROWS = 1000;

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALUE = /^\d{1,12}(\.\d{1,6})?$/;

function validDay(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * CSV `period;value[;publishedAt]` (séparateur paramétrable, `;` par défaut).
 *
 *  - en-tête facultatif (première ligne commençant par « period » / « periode ») ;
 *  - lignes vides et commentaires (`#`) ignorés ;
 *  - `period` au format YYYY-MM ; `value` décimale positive, point décimal
 *    (virgule décimale acceptée si `decimalComma` et séparateur ≠ virgule) ;
 *  - `publishedAt` facultatif (YYYY-MM-DD, pas avant la période) ;
 *  - une période présente deux fois dans le fichier est une erreur : on ne
 *    choisit pas entre deux valeurs.
 *
 * Toutes les erreurs sont collectées (numéro de ligne + motif) : l'utilisateur
 * corrige son fichier en une fois.
 */
export class CsvIndexConnector implements IndexConnector {
  readonly type = 'CSV';

  parse(content: Buffer, config: Readonly<Record<string, unknown>> | null): IndexImportParseResult {
    const delimiter = typeof config?.delimiter === 'string' ? config.delimiter : ';';
    const decimalComma = config?.decimalComma === true && delimiter !== ',';
    const text = content.toString('utf8').replace(/^﻿/, '');
    const rows: IndexImportRow[] = [];
    const errors: IndexImportError[] = [];
    const seen = new Map<string, number>();

    const lines = text.split(/\r?\n/);
    for (const [i, raw] of lines.entries()) {
      const line = i + 1;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (rows.length === 0 && errors.length === 0 && /^p[eé]riod/i.test(trimmed)) continue; // en-tête
      if (rows.length + errors.length >= MAX_IMPORT_ROWS) {
        errors.push({ line, message: `Au plus ${MAX_IMPORT_ROWS} lignes par import.` });
        break;
      }
      const cells = trimmed.split(delimiter).map((c) => c.trim());
      if (cells.length < 2 || cells.length > 3) {
        errors.push({ line, message: `2 ou 3 colonnes attendues (period${delimiter}value[${delimiter}publishedAt]), ${cells.length} reçue(s).` });
        continue;
      }
      const [period = '', rawValue = '', publishedAt = ''] = cells;
      const value = decimalComma ? rawValue.replace(',', '.') : rawValue;
      const problems: string[] = [];
      if (!PERIOD.test(period)) problems.push(`période « ${period} » invalide (YYYY-MM attendu)`);
      if (!VALUE.test(value) || Number(value) <= 0) problems.push(`valeur « ${rawValue} » invalide (décimal positif, ≤ 6 décimales)`);
      if (publishedAt !== '' && !validDay(publishedAt)) problems.push(`date de publication « ${publishedAt} » invalide (YYYY-MM-DD)`);
      else if (publishedAt !== '' && PERIOD.test(period) && publishedAt < `${period}-01`) {
        problems.push('publication antérieure à la période');
      }
      if (PERIOD.test(period)) {
        const first = seen.get(period);
        if (first !== undefined) problems.push(`période ${period} déjà présente ligne ${first}`);
        else seen.set(period, line);
      }
      if (problems.length) errors.push({ line, message: problems.join(' ; ') });
      else rows.push({ line, period, value, publishedAt: publishedAt === '' ? null : publishedAt });
    }
    return { rows, errors };
  }
}
