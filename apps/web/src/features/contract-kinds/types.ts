/**
 * Formes renvoyées par l'API des types de contrats et grilles tarifaires
 * (apps/api/src/contract-kinds/*.ts). Prix : chaînes décimales en euros (point).
 */

export type PriceUnitCode = 'PER_USER' | 'PER_DEVICE' | 'PER_LICENSE' | 'PER_UNIT' | 'FLAT' | 'PER_HOUR';
export type GridRecurrence = 'MONTHLY' | 'YEARLY' | 'ONE_OFF';

export interface ContractKindRow {
  id: string;
  prefix: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isSystem: boolean;
  systemKey: string | null;
  contractTemplateId: string | null;
  /** Préfixe figé : au moins un code de base a été créé. */
  prefixLocked: boolean;
  itemCount?: number;
  archivedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommitmentTermRow {
  id: string;
  months: number;
  label: string;
  archivedAt: string | null;
}

export interface UpcomingPrice {
  effectiveFrom: string;
  unitPrice: string;
  purchasePrice: string | null;
}

export interface GridVariant {
  code: string;
  months: number;
  archivedAt: string | null;
  /** Prix en vigueur à la date demandée ; null = non proposée (ou pas encore de prix). */
  unitPrice: string | null;
  purchasePrice: string | null;
  effectiveFrom: string | null;
  upcoming: UpcomingPrice | null;
}

export interface GridItem {
  id: string;
  code: string;
  number: number;
  label: string;
  description: string | null;
  unit: PriceUnitCode;
  recurrence: GridRecurrence;
  vatRatePercent: string;
  sortOrder: number;
  archivedAt: string | null;
  variants: GridVariant[];
}

export interface GridResponse {
  on: string;
  kind: ContractKindRow;
  terms: CommitmentTermRow[];
  items: GridItem[];
}

export interface DurationPrice {
  months: number;
  unitPrice: string | null;
  purchasePrice?: string | null;
}

export interface PriceHistoryRow {
  id: string;
  effectiveFrom: string;
  unitPrice: string;
  purchasePrice: string | null;
  enteredByUserId: string | null;
  createdAt: string;
}

export interface ItemHistory {
  code: string;
  label: string;
  variants: Array<{ code: string; months: number; archivedAt: string | null; prices: PriceHistoryRow[] }>;
}

export interface ImportReport {
  dryRun: boolean;
  effectiveFrom: string;
  created: string[];
  updated: string[];
  pricesAdded: number;
  variantsWithdrawn: number;
}

export interface ContractTemplateOption {
  id: string;
  name: string;
  slug: string | null;
  category: string;
  status: string;
}

/** Version d'un code telle qu'un document la COPIE (GET /v1/price-grid/variants). */
export interface VariantSnapshot {
  code: string;
  itemCode: string;
  months: number;
  termLabel: string;
  label: string;
  description: string | null;
  unit: string;
  recurrence: GridRecurrence;
  vatRatePercent: string;
  unitPrice: string;
  purchasePrice: string | null;
  effectiveFrom: string;
  on: string;
  kind: { id: string; prefix: string; label: string };
}
