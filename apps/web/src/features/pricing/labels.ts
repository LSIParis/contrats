import { formatCents, formatDecimal } from '../../lib/money.js';
import type { StatusTone } from '../../ui/theme/status.js';
import type { LineKind, OverrideStatus, PricingMode, Recurrence, RuleType, ScheduleStatus, TraceStep } from './types.js';

/** Libellés français de la tarification (04-tarification.md §4). */

export const KIND_LABELS: Record<LineKind, string> = {
  FLAT_MONTHLY: 'Forfait mensuel',
  FLAT_YEARLY: 'Forfait annuel',
  UNIT: 'Prix unitaire × quantité',
  HOURLY: 'Taux horaire',
  HOUR_PACK: 'Pack d’heures',
  SETUP_FEE: 'Frais de mise en service',
  TIERED: 'Paliers',
  DISCOUNT: 'Remise',
};

export const MODE_LABELS: Record<PricingMode, string> = {
  MANUAL: 'Manuel (prix saisi)',
  RULE: 'Règle du catalogue',
  FORMULA: 'Formule',
};

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  MONTHLY: 'Mensuelle',
  YEARLY: 'Annuelle',
  ONE_OFF: 'Ponctuelle',
};

export const SCHEDULE_STATUS: Record<ScheduleStatus, { label: string; tone: StatusTone }> = {
  DRAFT: { label: 'Brouillon', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'success' },
  SUPERSEDED: { label: 'Remplacée', tone: 'muted' },
};

export const OVERRIDE_STATUS: Record<OverrideStatus, { label: string; tone: StatusTone }> = {
  PENDING_APPROVAL: { label: 'En attente de seconde validation', tone: 'warn' },
  ACTIVE: { label: 'Active', tone: 'success' },
  REJECTED: { label: 'Refusée', tone: 'danger' },
  CANCELLED: { label: 'Annulée', tone: 'muted' },
};

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  GRID: 'Grille de prix par article',
  TIERS: 'Table de paliers',
  VOLUME_DISCOUNT: 'Remise sur volume',
  COMMITMENT_DISCOUNT: 'Remise d’engagement',
};

export const LOOKUP_LABELS: Record<string, string> = {
  LATEST_PUBLISHED: 'Dernière valeur publiée à la date',
  EXACT_PERIOD: 'Valeur de la période exacte',
};

const OVERRIDE_SKIP: Record<string, string> = {
  EMPTY_REASON: 'motif vide',
  REQUIRES_SECOND_APPROVAL: 'seconde validation requise',
  SELF_APPROVAL: 'validée par son auteur',
  SUPERSEDED: 'remplacée par une dérogation plus récente',
  NOT_APPLICABLE: 'hors période',
};

const ROUNDING_TARGET: Record<string, string> = {
  UNIT_PRICE: 'prix unitaire',
  LINE_TOTAL: 'total de ligne',
  AVERAGE_UNIT_PRICE: 'prix unitaire moyen',
};

export const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—';

const s = (v: unknown): string => (v == null ? '' : String(v));
const dec = (v: unknown): string => formatDecimal(s(v) || null);
const num = (v: unknown): string => formatDecimal(s(v) || null, { minFraction: 0 });

function obs(o: unknown): string {
  const x = (o ?? {}) as Record<string, unknown>;
  return `${s(x.indexCode)} ${s(x.period)} = ${dec(x.value)} (publiée le ${fmtDay(s(x.publishedAt))})`;
}

/**
 * Une étape de trace du moteur (packages/pricing/src/trace.ts) en français.
 * Toutes les valeurs sont des chaînes décimales en euros (centimes pour les
 * champs `…Cents`) : affichées telles quelles, jamais recalculées.
 */
export function describeStep(step: TraceStep): string {
  const t = step as Record<string, unknown>;
  switch (step.type) {
    case 'QUANTITY':
      return `Quantité : ${num(t.quantity)} (source ${s(t.source)}${t.observedAt ? `, relevée le ${new Date(s(t.observedAt)).toLocaleString('fr-FR')}` : ''})`;
    case 'BASE_PRICE':
      return `Prix de base (${MODE_LABELS[t.mode as PricingMode] ?? s(t.mode)}) : ${dec(t.unitPrice)} €`;
    case 'RULE_PRICE':
      return `Règle « ${s(t.ruleId)} », article ${s(t.articleCode)} : ${dec(t.unitPrice)} €`;
    case 'TIERS': {
      const bands = Array.isArray(t.bands) ? (t.bands as Array<Record<string, unknown>>) : [];
      const detail = bands
        .map((b) => `${num(b.quantity)} × ${dec(b.unitPrice)} € (${num(b.from)} → ${b.to == null ? '∞' : num(b.to)}) = ${dec(b.amount)} €`)
        .join(' ; ');
      return `Paliers ${t.tierMode === 'VOLUME' ? 'au volume' : 'par tranches'}${t.ruleId ? ` (règle « ${s(t.ruleId)} »)` : ''} : ${detail} → ${dec(t.amount)} €`;
    }
    case 'INDEX':
      return `Indice (variable ${s(t.variable)}) : ${obs(t.observation)}`;
    case 'FORMULA': {
      const vars = Object.entries((t.variables ?? {}) as Record<string, unknown>).map(([k, v]) => `${k} = ${s(v)}`).join(', ');
      return `Formule ${s(t.expression)}${vars ? ` avec ${vars}` : ''} = ${dec(t.result)}`;
    }
    case 'REVISION':
      return `Révision P1 = P0 × (a + b × S1 / S0) : P0 = ${dec(t.P0)}, a = ${s(t.a)}, b = ${s(t.b)}, S0 = ${obs(t.S0)}, S1 = ${obs(t.S1)} ; coefficient ${s(t.coefficient)} → ${dec(t.result)} €`;
    case 'REVISION_NOT_EFFECTIVE':
      return `Révision non encore effective (date de révision ${fmtDay(s(t.revisionDate))}, calcul au ${fmtDay(s(t.date))})`;
    case 'ADJUSTMENT':
      return `${t.ruleType === 'COMMITMENT_DISCOUNT' ? 'Remise d’engagement' : 'Remise sur volume'} « ${s(t.ruleId)} » (base ${s(t.basis)}${t.threshold != null ? `, seuil ${s(t.threshold)}` : ''}) : −${s(t.percent)} % — ${dec(t.before)} € → ${dec(t.after)} €`;
    case 'ROUNDING':
      return `Arrondi du ${ROUNDING_TARGET[s(t.target)] ?? s(t.target)} à ${s(t.scale)} décimale(s) (${s(t.mode)}) : ${s(t.exact)} → ${s(t.rounded)}`;
    case 'OVERRIDE_APPLIED':
      return `Dérogation appliquée : ${dec(t.unitPrice)} € au lieu de ${dec(t.computedUnitPrice)} €${t.gapPercent != null ? ` (écart ${s(t.gapPercent)} %)` : ''}, du ${fmtDay(s(t.validFrom))} au ${fmtDay(s(t.validTo))} — motif : « ${s(t.reason)} »`;
    case 'OVERRIDE_SKIPPED':
      return `Dérogation écartée : ${OVERRIDE_SKIP[s(t.reason)] ?? s(t.reason)}${t.gapPercent != null ? ` (écart ${s(t.gapPercent)} %)` : ''}`;
    case 'HOUR_PACK':
      return `Pack de ${num(t.hoursPerPack)} h : taux horaire effectif ${dec(t.effectiveHourlyRate)} €`;
    case 'DISCOUNT': {
      const targets = Array.isArray(t.targetLineIds) ? (t.targetLineIds as string[]).join(', ') : '';
      return `Remise ${t.discountType === 'PERCENT' ? `${s(t.value)} %` : `${dec(t.value)} €`} sur ${targets || 'le sous-total'} (base ${formatCents(s(t.baseHtCents))}) : ${dec(t.exact)} €`;
    }
    case 'LINE_TOTAL':
      return `Total de ligne : ${dec(t.unitPrice)} € × ${num(t.quantity)} = ${dec(t.exact)} € (avant arrondi)`;
    default:
      return `${step.type} : ${JSON.stringify(step)}`;
  }
}
