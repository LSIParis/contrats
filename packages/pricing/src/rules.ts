import { PricingError } from './errors.js';
import { D, parseDecimal, type Decimal } from './money.js';
import type { PricingContext, PricingRule, RuleCatalog } from './types.js';

/**
 * Catalogue de règles du tenant (mode RULE).
 *
 * Une ligne en mode RULE nomme :
 *  - une règle de PRIX : GRID (grille par code article) ou TIERS (paliers) ;
 *  - zéro, une ou plusieurs règles d'AJUSTEMENT, appliquées dans l'ordre
 *    donné, chacune en pourcentage multiplicatif sur le montant exact :
 *      VOLUME_DISCOUNT      — seuil le plus élevé ≤ quantité ;
 *      COMMITMENT_DISCOUNT  — seuil le plus élevé ≤ durée d'engagement (mois).
 *    Deux remises de 10 % et 5 % donnent donc ×0,90×0,95 = −14,5 %, pas −15 % :
 *    c'est la lecture usuelle des remises « en cascade », et elle ne dépend
 *    pas de l'ordre (la multiplication est commutative).
 *
 * Règle absente, entrée de grille absente, durée d'engagement non fournie :
 * erreur typée. Le catalogue est chargé par la couche persistance dans sa
 * version applicable ; le moteur ne connaît pas l'historique du catalogue.
 */

export function findRule(catalog: RuleCatalog | undefined, ruleId: string, lineId: string): PricingRule {
  const rule = catalog?.rules.find((r) => r.id === ruleId);
  if (!rule) {
    throw new PricingError('RULE_NOT_FOUND', `Ligne ${lineId} : règle « ${ruleId} » absente du catalogue.`, { lineId, ruleId });
  }
  return rule;
}

export function gridUnitPrice(rule: Extract<PricingRule, { type: 'GRID' }>, articleCode: string, lineId: string): Decimal {
  const entry = rule.entries.find((e) => e.articleCode === articleCode);
  if (!entry) {
    throw new PricingError('RULE_NOT_FOUND', `Ligne ${lineId} : l’article « ${articleCode} » ne figure pas dans la grille « ${rule.id} ».`, {
      lineId,
      ruleId: rule.id,
      articleCode,
    });
  }
  return parseDecimal(entry.unitPrice, `grille ${rule.id} / ${articleCode}`);
}

export interface AdjustmentResult {
  readonly ruleId: string;
  readonly ruleType: 'VOLUME_DISCOUNT' | 'COMMITMENT_DISCOUNT';
  /** Seuil retenu (quantité ou mois), ou null si aucun seuil n'est atteint. */
  readonly threshold: string | null;
  /** Pourcentage de remise retenu (0 si aucun seuil atteint). */
  readonly percent: Decimal;
  /** Valeur comparée aux seuils (quantité ou mois d'engagement). */
  readonly basis: string;
}

function assertPercent(p: Decimal, field: string): Decimal {
  if (p.gt(100)) throw new PricingError('INVALID_LINE', `${field} : un pourcentage ne peut excéder 100.`, { field });
  return p;
}

export function adjustmentFor(
  rule: PricingRule,
  quantity: Decimal,
  context: PricingContext | undefined,
  lineId: string,
): AdjustmentResult {
  if (rule.type === 'VOLUME_DISCOUNT') {
    let best: { min: Decimal; percent: Decimal } | null = null;
    for (const [i, t] of rule.thresholds.entries()) {
      const min = parseDecimal(t.minQuantity, `règle ${rule.id}.thresholds[${i}].minQuantity`);
      const percent = assertPercent(parseDecimal(t.percent, `règle ${rule.id}.thresholds[${i}].percent`), `règle ${rule.id}`);
      if (min.lte(quantity) && (!best || min.gt(best.min))) best = { min, percent };
    }
    const chosen = best;
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      threshold: chosen?.min.toString() ?? null,
      percent: chosen?.percent ?? D(0),
      basis: quantity.toString(),
    };
  }
  if (rule.type === 'COMMITMENT_DISCOUNT') {
    const months = context?.commitmentMonths;
    if (months === undefined || !Number.isInteger(months) || months < 0) {
      throw new PricingError(
        'MISSING_CONTEXT',
        `Ligne ${lineId} : la règle « ${rule.id} » (remise d’engagement) exige context.commitmentMonths (entier ≥ 0).`,
        { lineId, ruleId: rule.id },
      );
    }
    let best: { min: number; percent: Decimal } | null = null;
    for (const [i, t] of rule.thresholds.entries()) {
      const percent = assertPercent(parseDecimal(t.percent, `règle ${rule.id}.thresholds[${i}].percent`), `règle ${rule.id}`);
      if (t.minMonths <= months && (!best || t.minMonths > best.min)) best = { min: t.minMonths, percent };
    }
    const chosen = best;
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      threshold: chosen ? String(chosen.min) : null,
      percent: chosen?.percent ?? D(0),
      basis: String(months),
    };
  }
  throw new PricingError('INVALID_LINE', `Ligne ${lineId} : la règle « ${rule.id} » (${rule.type}) n’est pas une règle d’ajustement.`, {
    lineId,
    ruleId: rule.id,
  });
}
