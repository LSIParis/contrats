import { PricingError } from './errors.js';
import { D, parseDecimal, parseIsoDate, type Decimal } from './money.js';
import type { PriceOverride } from './types.js';

/**
 * Dérogations manuelles ponctuelles (PriceOverride). (brief §5, mode 3)
 *
 * Une dérogation remplace le PRIX UNITAIRE calculé d'une ligne, sur une
 * période bornée [validFrom, validTo] (bornes incluses). Garde-fous :
 *
 *  - motif obligatoire (non vide après suppression des blancs) ;
 *  - écart = |prix dérogé − prix calculé| / prix calculé × 100. Au-delà
 *    (STRICTEMENT) du seuil paramétrable `overrideApprovalThresholdPercent`,
 *    la dérogation exige une double validation : `approvedBy` renseigné ET
 *    différent de l'auteur. Un prix calculé nul rend l'écart infini : toute
 *    dérogation non nulle exige alors la double validation ;
 *  - une dérogation qui ne remplit pas ces conditions n'est PAS appliquée par
 *    priceAt ; elle est listée dans la trace avec la raison. On ne bloque pas
 *    le calcul du barème entier pour une dérogation en attente, mais on ne
 *    l'applique jamais « en attendant ».
 *
 * Le calcul de l'écart dépend du prix calculé À LA DATE : une même dérogation
 * peut passer sous le seuil puis au-dessus après une révision d'indice. C'est
 * voulu : le seuil protège contre un écart réel, pas contre un écart historique.
 */

export type OverrideSkipReason =
  | 'EMPTY_REASON'
  | 'REQUIRES_SECOND_APPROVAL'
  | 'SELF_APPROVAL'
  | 'SUPERSEDED'
  | 'NOT_APPLICABLE';

export interface OverrideIssue {
  readonly code: 'EMPTY_REASON' | 'INVALID_PERIOD' | 'SELF_APPROVAL' | 'INVALID_PRICE';
  readonly message: string;
}

/** Écart relatif en %, ou null si infini (prix calculé nul, prix dérogé non nul). */
export function overrideGapPercent(overridePrice: Decimal, computedPrice: Decimal): Decimal | null {
  const diff = overridePrice.minus(computedPrice).abs();
  if (computedPrice.isZero()) return diff.isZero() ? D(0) : null;
  return diff.div(computedPrice.abs()).times(100);
}

export function requiresSecondApproval(overridePrice: Decimal, computedPrice: Decimal, thresholdPercent: Decimal): boolean {
  const gap = overrideGapPercent(overridePrice, computedPrice);
  return gap === null || gap.gt(thresholdPercent);
}

/**
 * Contrôle à l'ÉCRITURE (API / interface), avant enregistrement. Ne lève pas :
 * renvoie la liste des problèmes. Le seuil de double validation n'est pas
 * vérifié ici : il dépend du prix calculé à la date, donc de priceAt.
 */
export function validateOverride(o: PriceOverride): OverrideIssue[] {
  const issues: OverrideIssue[] = [];
  if (typeof o.reason !== 'string' || o.reason.trim() === '') {
    issues.push({ code: 'EMPTY_REASON', message: 'Le motif de la dérogation est obligatoire.' });
  }
  try {
    const from = parseIsoDate(o.validFrom, 'validFrom');
    const to = parseIsoDate(o.validTo, 'validTo');
    if (from > to) issues.push({ code: 'INVALID_PERIOD', message: `Période inversée : ${from} > ${to}.` });
  } catch (e) {
    issues.push({ code: 'INVALID_PERIOD', message: (e as Error).message });
  }
  if (o.approvedBy != null && o.approvedBy === o.authorId) {
    issues.push({ code: 'SELF_APPROVAL', message: 'Le second validateur doit être distinct de l’auteur de la dérogation.' });
  }
  try {
    parseDecimal(o.unitPrice, 'unitPrice');
  } catch (e) {
    issues.push({ code: 'INVALID_PRICE', message: (e as Error).message });
  }
  return issues;
}

export interface AppliedOverride {
  readonly override: PriceOverride;
  readonly unitPrice: Decimal;
  readonly gapPercent: Decimal | null;
  readonly requiresSecondApproval: boolean;
}

export interface SkippedOverride {
  readonly overrideId: string;
  readonly reason: OverrideSkipReason;
  /** Écart en % (chaîne), null si infini ou non calculé. */
  readonly gapPercent: string | null;
}

export interface OverrideSelection {
  readonly applied: AppliedOverride | null;
  readonly skipped: readonly SkippedOverride[];
}

/**
 * Choisit la dérogation applicable à `date` parmi celles d'UNE ligne.
 * Plusieurs éligibles : la plus récente (validFrom le plus tardif) l'emporte,
 * les autres sont SUPERSEDED. Égalité de validFrom entre éligibles :
 * AMBIGUOUS_OVERRIDE — le moteur ne choisit pas arbitrairement entre deux prix.
 */
export function selectOverride(
  overrides: readonly PriceOverride[],
  date: string,
  computedUnitPrice: Decimal,
  thresholdPercent: Decimal,
): OverrideSelection {
  const skipped: SkippedOverride[] = [];
  const eligible: AppliedOverride[] = [];

  for (const o of overrides) {
    if (!(o.validFrom <= date && date <= o.validTo)) continue;
    const unitPrice = parseDecimal(o.unitPrice, `dérogation ${o.id} : unitPrice`);
    const gap = overrideGapPercent(unitPrice, computedUnitPrice);
    const gapStr = gap === null ? null : gap.toString();
    if (typeof o.reason !== 'string' || o.reason.trim() === '') {
      skipped.push({ overrideId: o.id, reason: 'EMPTY_REASON', gapPercent: gapStr });
      continue;
    }
    const needs = gap === null || gap.gt(thresholdPercent);
    if (needs) {
      if (o.approvedBy == null || o.approvedBy === '') {
        skipped.push({ overrideId: o.id, reason: 'REQUIRES_SECOND_APPROVAL', gapPercent: gapStr });
        continue;
      }
      if (o.approvedBy === o.authorId) {
        skipped.push({ overrideId: o.id, reason: 'SELF_APPROVAL', gapPercent: gapStr });
        continue;
      }
    }
    eligible.push({ override: o, unitPrice, gapPercent: gap, requiresSecondApproval: needs });
  }

  if (eligible.length === 0) return { applied: null, skipped };

  const latest = eligible.reduce((a, b) => (b.override.validFrom > a.override.validFrom ? b : a));
  const ties = eligible.filter((e) => e.override.validFrom === latest.override.validFrom);
  if (ties.length > 1) {
    throw new PricingError(
      'AMBIGUOUS_OVERRIDE',
      `Ligne ${latest.override.lineId} : dérogations ${ties.map((t) => t.override.id).join(', ')} simultanément applicables au ${date}, même date de début.`,
      { lineId: latest.override.lineId, date },
    );
  }
  for (const e of eligible) {
    if (e !== latest) {
      skipped.push({
        overrideId: e.override.id,
        reason: 'SUPERSEDED',
        gapPercent: e.gapPercent === null ? null : e.gapPercent.toString(),
      });
    }
  }
  return { applied: latest, skipped };
}
