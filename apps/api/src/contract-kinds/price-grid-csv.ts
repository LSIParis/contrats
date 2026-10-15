import {
  commitmentSuffix,
  GRID_RECURRENCES,
  PRICE_UNITS,
  type GridRecurrence,
  type PriceUnitCode,
} from '@lsi/domain';
import { csvCell } from '../proposals/proposal-reporting.service.js';
import { MAX_DESCRIPTION_LENGTH, sanitizeDescription } from '../common/html-description.js';

/**
 * Import / export CSV de la grille d'un type de contrat
 * (docs/contrats/13-types-contrats.md §6).
 *
 * Format (séparateur « ; », UTF-8 avec BOM, virgule ou point décimal) :
 *
 *   code;libelle;description;unite;periodicite;tva;E00;E12;E24;E36;achat_E00;…
 *
 *  - `code` vide = nouveau code de base (numéro attribué par la base) ;
 *  - unité et périodicité : libellé (« par utilisateur », « mensuelle ») ou
 *    code (PER_USER, MONTHLY) ;
 *  - une colonne `Edd` absente = durée inchangée ; une CELLULE vide = version
 *    non proposée pour cette durée ; `achat_Edd` facultatif ;
 *  - `description` : texte ou HTML (balises de mise en forme), assaini.
 *
 * Toutes les erreurs sont collectées (ligne + motif) : le fichier se corrige
 * en une fois, rien n'est écrit tant qu'il en reste.
 */

export const MAX_GRID_IMPORT_ROWS = 1000;

export interface GridCsvExportItem {
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly unit: string;
  readonly recurrence: string;
  readonly vatRatePercent: string;
  /** Par nombre de mois : prix en vigueur (null = non proposée). */
  readonly prices: ReadonlyMap<number, { unitPrice: string; purchasePrice: string | null } | null>;
}

const unitLabel = (code: string) => PRICE_UNITS.find((u) => u.code === code)?.label ?? code;
const recurrenceLabel = (code: string) => GRID_RECURRENCES.find((r) => r.code === code)?.label ?? code;
const frenchDecimal = (v: string | null | undefined) => (v === null || v === undefined ? '' : v.replace('.', ','));

export function formatGridCsv(months: readonly number[], items: readonly GridCsvExportItem[]): string {
  const head = [
    'code', 'libelle', 'description', 'unite', 'periodicite', 'tva',
    ...months.map(commitmentSuffix), ...months.map((m) => `achat_${commitmentSuffix(m)}`),
  ];
  const rows = items.map((i) => [
    i.code, i.label, i.description, unitLabel(i.unit), recurrenceLabel(i.recurrence), frenchDecimal(i.vatRatePercent),
    ...months.map((m) => frenchDecimal(i.prices.get(m)?.unitPrice)),
    ...months.map((m) => frenchDecimal(i.prices.get(m)?.purchasePrice)),
  ]);
  return '﻿' + [head, ...rows].map((l) => l.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export interface GridImportRow {
  readonly line: number;
  readonly code: string | null;
  readonly label: string;
  readonly description: string | null;
  readonly unit: PriceUnitCode;
  readonly recurrence: GridRecurrence;
  readonly vatRatePercent: string;
  /** Durées PRÉSENTES dans le fichier : prix (null = non proposée). */
  readonly prices: ReadonlyMap<number, { unitPrice: string | null; purchasePrice: string | null }>;
}

export interface GridImportError {
  readonly line: number;
  readonly message: string;
}

/** Découpe une ligne CSV (guillemets, « "" » échappé). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Annule la neutralisation des formules de l'export (« '=… » → « =… »). */
const unescapeCell = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

const DEC6 = /^\d{1,14}(\.\d{1,6})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const normDecimal = (s: string) => s.replace(/\s/g, '').replace(',', '.');
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function lookup<T extends string>(value: string, table: readonly { code: T; label: string }[]): T | null {
  const v = norm(value);
  return table.find((e) => norm(e.code) === v || norm(e.label) === v)?.code ?? null;
}

/**
 * `knownMonths` : durées existantes du tenant (colonnes Edd acceptées).
 * `prefix` : préfixe du type — un code d'un autre type est refusé.
 */
export function parseGridCsv(content: Buffer, knownMonths: ReadonlySet<number>, prefix: string): { rows: GridImportRow[]; errors: GridImportError[] } {
  const lines = content.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const rows: GridImportRow[] = [];
  const errors: GridImportError[] = [];
  const headerIdx = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('#'));
  if (headerIdx < 0) return { rows, errors: [{ line: 1, message: 'Fichier vide.' }] };

  const header = splitCsvLine(lines[headerIdx]!).map((h) => norm(h));
  const col = (name: string) => header.indexOf(name);
  for (const required of ['code', 'libelle', 'unite', 'periodicite', 'tva']) {
    if (col(required) < 0) errors.push({ line: headerIdx + 1, message: `Colonne « ${required} » absente de l'en-tête.` });
  }
  const priceCols = new Map<number, { price: number; purchase: number }>();
  for (const [i, h] of header.entries()) {
    const m = /^(achat_)?e(\d{2})$/.exec(h);
    if (!m) continue;
    const months = Number(m[2]);
    if (!knownMonths.has(months)) {
      errors.push({ line: headerIdx + 1, message: `Colonne « ${h.toUpperCase()} » : aucune durée de ${months} mois dans le référentiel.` });
      continue;
    }
    const entry = priceCols.get(months) ?? { price: -1, purchase: -1 };
    if (m[1]) entry.purchase = i; else entry.price = i;
    priceCols.set(months, entry);
  }
  for (const [months, c] of priceCols) {
    if (c.price < 0) errors.push({ line: headerIdx + 1, message: `Colonne « achat_${commitmentSuffix(months)} » sans colonne « ${commitmentSuffix(months)} ».` });
  }
  if (errors.length) return { rows, errors };

  const seen = new Map<string, number>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const line = i + 1;
    if (rows.length >= MAX_GRID_IMPORT_ROWS) { errors.push({ line, message: `Au plus ${MAX_GRID_IMPORT_ROWS} lignes par import.` }); break; }
    const cells = splitCsvLine(raw).map(unescapeCell);
    const cell = (name: string) => cells[col(name)] ?? '';
    const before = errors.length;

    const code = cell('code') || null;
    if (code) {
      if (!new RegExp(`^${prefix}-\\d{4,}$`).test(code)) errors.push({ line, message: `Code « ${code} » : pas un code de base du type ${prefix}.` });
      else if (seen.has(code)) errors.push({ line, message: `Code « ${code} » déjà présent ligne ${seen.get(code)}.` });
      else seen.set(code, line);
    }
    const label = cell('libelle');
    if (!label) errors.push({ line, message: 'Libellé obligatoire.' });
    const unit = lookup(cell('unite'), PRICE_UNITS);
    if (!unit) errors.push({ line, message: `Unité « ${cell('unite')} » inconnue (${PRICE_UNITS.map((u) => u.label).join(', ')}).` });
    const recurrence = lookup(cell('periodicite'), GRID_RECURRENCES);
    if (!recurrence) errors.push({ line, message: `Périodicité « ${cell('periodicite')} » inconnue (mensuelle, annuelle, ponctuelle).` });
    const vat = normDecimal(cell('tva'));
    if (!PERCENT.test(vat) || Number(vat) > 100) errors.push({ line, message: `TVA « ${cell('tva')} » invalide (pourcentage, ex. 20 ou 5,5).` });

    const description = sanitizeDescription(cell('description'));
    if (description.length > MAX_DESCRIPTION_LENGTH) errors.push({ line, message: `Description trop longue (au plus ${MAX_DESCRIPTION_LENGTH} caractères).` });

    const prices = new Map<number, { unitPrice: string | null; purchasePrice: string | null }>();
    for (const [months, c] of priceCols) {
      const p = normDecimal(cells[c.price] ?? '');
      const a = c.purchase >= 0 ? normDecimal(cells[c.purchase] ?? '') : '';
      if (p && !DEC6.test(p)) errors.push({ line, message: `${commitmentSuffix(months)} : prix « ${cells[c.price]} » invalide.` });
      if (a && !DEC6.test(a)) errors.push({ line, message: `achat_${commitmentSuffix(months)} : prix « ${cells[c.purchase]} » invalide.` });
      if (!p && a) errors.push({ line, message: `${commitmentSuffix(months)} : prix d'achat sans prix de vente.` });
      prices.set(months, { unitPrice: p || null, purchasePrice: a || null });
    }
    if (errors.length > before) continue;
    rows.push({
      line, code, label, description: description || null, unit: unit!, recurrence: recurrence!, vatRatePercent: vat, prices,
    });
  }
  return { rows, errors };
}
