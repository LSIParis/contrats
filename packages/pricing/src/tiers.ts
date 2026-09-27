import { PricingError } from './errors.js';
import { D, parseDecimal, type Decimal } from './money.js';
import type { TierMode, TierTable } from './types.js';

/**
 * Paliers et dégressivité.
 *
 * Un palier couvre l'intervalle ]borne précédente, upTo] (borne haute
 * INCLUSE, le premier palier part de 0). Deux lectures, à choisir
 * explicitement :
 *
 *  - GRADUATED (« par tranches ») : chaque unité est facturée au prix de la
 *    tranche dans laquelle elle tombe. Avec 1–10 à 30 € et 11–50 à 25 €,
 *    12 postes = 10×30 + 2×25 = 350 €. Propriété : le total est une fonction
 *    CROISSANTE de la quantité (prix ≥ 0) — testée par propriété.
 *
 *  - VOLUME (« au palier atteint ») : toute la quantité est facturée au prix
 *    du palier atteint. 12 postes = 12×25 = 300 €. Propriété : le total N'EST
 *    PAS monotone — 10 postes = 300 €, 11 postes = 275 €. C'est l'effet de
 *    seuil voulu par ce modèle commercial ; ce qui reste vrai (et testé) :
 *    le prix UNITAIRE est décroissant si les prix des paliers le sont, et le
 *    total est croissant À L'INTÉRIEUR d'un même palier.
 *
 * Une quantité au-delà du dernier palier borné est une erreur de barème :
 * on ne « prolonge » pas le dernier prix en silence.
 */

export interface TierBand {
  readonly from: string;
  readonly to: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
}

export interface TierComputation {
  readonly mode: TierMode;
  /** Montant HT exact (non arrondi). */
  readonly exact: Decimal;
  readonly bands: readonly TierBand[];
}

interface ParsedTier {
  readonly upTo: Decimal | null;
  readonly unitPrice: Decimal;
}

function invalid(field: string, msg: string): PricingError {
  return new PricingError('INVALID_LINE', `${field} : ${msg}`, { field });
}

export function parseTierTable(table: TierTable, field: string): readonly ParsedTier[] {
  if (table.mode !== 'GRADUATED' && table.mode !== 'VOLUME') {
    throw invalid(field, `mode de paliers « ${String(table.mode)} » inconnu (GRADUATED ou VOLUME).`);
  }
  if (!Array.isArray(table.tiers) || table.tiers.length === 0) throw invalid(field, 'au moins un palier est requis.');
  const parsed: ParsedTier[] = [];
  let prev = D(0);
  table.tiers.forEach((t, i) => {
    const unitPrice = parseDecimal(t.unitPrice, `${field}.tiers[${i}].unitPrice`);
    if (t.upTo === null) {
      if (i !== table.tiers.length - 1) throw invalid(field, 'seul le dernier palier peut être illimité (upTo = null).');
      parsed.push({ upTo: null, unitPrice });
      return;
    }
    const upTo = parseDecimal(t.upTo, `${field}.tiers[${i}].upTo`);
    if (!upTo.gt(prev)) throw invalid(field, `les bornes des paliers doivent être strictement croissantes et positives (palier ${i}).`);
    parsed.push({ upTo, unitPrice });
    prev = upTo;
  });
  return parsed;
}

export function computeTiered(table: TierTable, quantity: Decimal, field: string): TierComputation {
  const tiers = parseTierTable(table, field);
  const last = tiers[tiers.length - 1] as ParsedTier;
  if (last.upTo !== null && quantity.gt(last.upTo)) {
    throw invalid(field, `quantité ${quantity.toString()} au-delà du dernier palier (${last.upTo.toString()}).`);
  }

  if (table.mode === 'VOLUME') {
    let from = D(0);
    for (const t of tiers) {
      if (t.upTo === null || quantity.lte(t.upTo)) {
        const amount = quantity.times(t.unitPrice);
        return {
          mode: 'VOLUME',
          exact: amount,
          bands: [
            {
              from: from.toString(),
              to: t.upTo?.toString() ?? null,
              quantity: quantity.toString(),
              unitPrice: t.unitPrice.toString(),
              amount: amount.toString(),
            },
          ],
        };
      }
      from = t.upTo;
    }
  }

  // GRADUATED
  const bands: TierBand[] = [];
  let total = D(0);
  let from = D(0);
  for (const t of tiers) {
    if (!quantity.gt(from)) break;
    const top = t.upTo === null ? quantity : minOf(quantity, t.upTo);
    const q = top.minus(from);
    const amount = q.times(t.unitPrice);
    bands.push({
      from: from.toString(),
      to: t.upTo?.toString() ?? null,
      quantity: q.toString(),
      unitPrice: t.unitPrice.toString(),
      amount: amount.toString(),
    });
    total = total.plus(amount);
    if (t.upTo === null) break;
    from = t.upTo;
  }
  return { mode: 'GRADUATED', exact: total, bands };
}

function minOf(a: Decimal, b: Decimal): Decimal {
  return a.lt(b) ? a : b;
}
