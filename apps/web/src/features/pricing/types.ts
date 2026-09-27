/**
 * Types des réponses de l'API de tarification (apps/api/src/pricing/*).
 *
 * Montants : prix unitaires en chaînes décimales (euros), totaux en chaînes
 * d'entiers (centimes). Jamais de nombre JSON pour de la monnaie : l'interface
 * les affiche via `lib/money.ts` (formatCents / formatDecimal), sans flottant.
 */

export type LineKind = 'FLAT_MONTHLY' | 'FLAT_YEARLY' | 'UNIT' | 'HOURLY' | 'HOUR_PACK' | 'SETUP_FEE' | 'TIERED' | 'DISCOUNT';
export type PricingMode = 'MANUAL' | 'RULE' | 'FORMULA';
export type Recurrence = 'MONTHLY' | 'YEARLY' | 'ONE_OFF';
export type IndexLookup = 'LATEST_PUBLISHED' | 'EXACT_PERIOD';
export type TierMode = 'GRADUATED' | 'VOLUME';

export interface TierTable { mode: TierMode; tiers: Array<{ upTo: string | null; unitPrice: string }> }
export interface RevisionSpec { indexCode: string; a: string; b: string; referenceDate: string; revisionDate: string; lookup?: IndexLookup }
export interface IndexBinding { indexCode: string; date: string; lookup?: IndexLookup }
export interface FormulaSpec {
  expression: string;
  basePrice?: string;
  variables?: Record<string, string>;
  indexVariables?: Record<string, IndexBinding>;
}
export interface RuleRef { priceRuleId: string; adjustmentRuleIds?: string[] }
export interface DiscountSpec {
  type: 'PERCENT' | 'AMOUNT';
  value: string;
  appliesTo: { scope: 'LINES'; lineIds: string[] } | { scope: 'SUBTOTAL' };
}

/** Ligne de barème telle que l'API l'accepte (`LineInputSchema`) et la renvoie (+ sortOrder). */
export interface LineInput {
  lineKey: string;
  articleCode: string;
  label: string;
  unit: string;
  kind: LineKind;
  mode: PricingMode;
  recurrence?: Recurrence | null;
  vatRatePercent: string;
  quantitySource?: 'FIXED' | 'PROVIDER';
  quantity?: string;
  providerArticleCode?: string;
  unitPrice?: string;
  tiers?: TierTable;
  rule?: RuleRef;
  formula?: FormulaSpec;
  revision?: RevisionSpec;
  hourPack?: { hoursPerPack: string };
  discount?: DiscountSpec;
  sortOrder?: number;
}

export type ScheduleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';

export interface ScheduleView {
  id: string;
  version: number;
  status: ScheduleStatus;
  validFrom: string;
  validTo: string | null;
  currency: string;
  commitmentMonths: number | null;
  note: string | null;
  createdByUserId: string;
  activatedByUserId: string | null;
  activatedAt: string | null;
  lines: LineInput[];
}

export interface SchedulesResponse { items: ScheduleView[]; nextRevisionDate: string | null }

export type TraceStep = { type: string } & Record<string, unknown>;

export interface PricedLine {
  lineId: string;
  code: string;
  label: string;
  unit: string;
  kind: LineKind;
  mode: PricingMode;
  recurrence: Recurrence;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  totalHtCents: string;
  trace?: TraceStep[];
}

export interface PricingTotals {
  htCents: string;
  vatCents: string;
  ttcCents: string;
  vatByRate: Array<{ ratePercent: string; baseHtCents: string; vatCents: string }>;
  monthlyLinesCents?: string;
  yearlyLinesCents?: string;
  oneOffCents?: string;
  monthlyRecurringCents: string;
  annualRecurringCents: string;
}

export interface PricingSettingsView {
  rounding: string;
  unitPriceScale: number;
  overrideApprovalThresholdPercent: string;
  indexLookup: string;
}

export interface PriceAtResult {
  contractId?: string;
  date: string;
  scheduleId: string;
  scheduleVersion?: number | null;
  scheduleValidFrom: string;
  scheduleValidTo: string | null;
  currency: 'EUR';
  settings?: PricingSettingsView;
  lines: PricedLine[];
  totals: PricingTotals;
  pendingOverrides?: Array<{ id: string; lineId: string; unitPrice: string; reason: string; authorUserId: string }>;
}

export interface LineDelta {
  lineId: string;
  label: string;
  beforeCents: string | null;
  afterCents: string | null;
  deltaCents: string;
  deltaPercent: string | null;
}

export interface SimulationResult {
  contractId: string;
  before: PriceAtResult;
  after: PriceAtResult;
  lineDeltas: LineDelta[];
  totalsDelta: { htCents: string; vatCents: string; ttcCents: string; monthlyRecurringCents: string; annualRecurringCents: string };
}

export type OverrideStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'CANCELLED';

export interface OverrideView {
  id: string;
  lineKey: string;
  unitPrice: string;
  validFrom: string;
  validTo: string;
  reason: string;
  computedUnitPrice: string | null;
  gapPercent: string | null;
  requiresSecondApproval: boolean;
  status: OverrideStatus;
  authorUserId: string;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedByUserId: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledByUserId: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

// --- Catalogue -------------------------------------------------------------

export interface PriceIndexRow {
  id: string;
  code: string;
  label: string;
  description: string | null;
  connector: { type: string; delimiter?: string; decimalComma?: boolean } | null;
  valuesCount: number;
  latest: { period: string; value: string; publishedAt: string } | null;
}

export interface IndexValueRow {
  id: string;
  period: string;
  value: string;
  publishedAt: string;
  source: 'MANUAL' | 'IMPORT';
  revision: number;
  supersedesId: string | null;
  correctionReason: string | null;
  enteredByUserId: string | null;
  createdAt: string;
  current: boolean;
}

export type RuleType = 'GRID' | 'TIERS' | 'VOLUME_DISCOUNT' | 'COMMITMENT_DISCOUNT';

export interface PricingRuleRow {
  id: string;
  code: string;
  type: RuleType;
  label: string;
  definition: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteResult {
  source: 'CONTRACT' | 'CATALOG';
  contractId?: string;
  scheduleVersion?: number | null;
  ruleCode?: string;
  articleCode: string;
  quantity: string;
  date: string;
  line: PricedLine;
  totals: PricingTotals;
}
