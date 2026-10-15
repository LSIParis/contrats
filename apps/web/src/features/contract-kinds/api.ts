import { apiRequest } from '../../lib/api.js';
import type {
  CommitmentTermRow, ContractKindRow, ContractTemplateOption, DurationPrice, GridItem, GridRecurrence, GridResponse,
  ImportReport, ItemHistory, PriceUnitCode,
} from './types.js';

/**
 * Client de l'API des types de contrats, durées d'engagement et grilles
 * tarifaires (apps/api/src/contract-kinds/contract-kinds.controller.ts).
 * Lecture : contracts.read ou proposals.read ; écriture : pricing.grid.manage.
 */
const K = '/v1/contract-kinds';
const enc = encodeURIComponent;

export interface KindInput { label?: string; prefix?: string; description?: string | null; sortOrder?: number; contractTemplateId?: string | null }
export interface ItemInput { label?: string; description?: string | null; unit?: PriceUnitCode; recurrence?: GridRecurrence; vatRatePercent?: string; sortOrder?: number }

export const contractKindsApi = {
  list: (archived: boolean) => apiRequest<{ items: ContractKindRow[] }>('GET', `${K}?archived=${archived}`),
  get: (id: string) => apiRequest<ContractKindRow>('GET', `${K}/${enc(id)}`),
  create: (b: KindInput) => apiRequest<ContractKindRow>('POST', K, b),
  update: (id: string, b: KindInput) => apiRequest<ContractKindRow>('PUT', `${K}/${enc(id)}`, b),
  setArchived: (id: string, archived: boolean) => apiRequest<ContractKindRow>('POST', `${K}/${enc(id)}/${archived ? 'archive' : 'unarchive'}`),
  remove: (id: string) => apiRequest<{ deleted: boolean }>('DELETE', `${K}/${enc(id)}`),

  grid: (id: string, on: string, archived: boolean) => apiRequest<GridResponse>('GET', `${K}/${enc(id)}/grid?on=${enc(on)}&archived=${archived}`),
  csvUrl: (id: string) => `${K}/${enc(id)}/grid.csv`,
  createItem: (id: string, b: ItemInput & { effectiveFrom?: string; prices?: DurationPrice[] }) =>
    apiRequest<GridItem>('POST', `${K}/${enc(id)}/grid/items`, b),
  importCsv: (id: string, file: File, effectiveFrom: string, dryRun: boolean) => {
    const form = new FormData();
    form.append('file', file);
    if (effectiveFrom) form.append('effectiveFrom', effectiveFrom);
    form.append('dryRun', String(dryRun));
    return apiRequest<ImportReport>('POST', `${K}/${enc(id)}/grid/import`, undefined, { form });
  },

  updateItem: (code: string, b: ItemInput) => apiRequest<GridItem>('PUT', `/v1/price-grid/items/${enc(code)}`, b),
  setPrices: (code: string, b: { effectiveFrom?: string; prices: DurationPrice[] }) =>
    apiRequest<GridItem>('POST', `/v1/price-grid/items/${enc(code)}/prices`, b),
  setItemArchived: (code: string, archived: boolean) =>
    apiRequest<GridItem>('POST', `/v1/price-grid/items/${enc(code)}/${archived ? 'archive' : 'unarchive'}`),
  history: (code: string) => apiRequest<ItemHistory>('GET', `/v1/price-grid/items/${enc(code)}/history`),

  terms: (archived: boolean) => apiRequest<{ items: CommitmentTermRow[] }>('GET', `/v1/commitment-terms?archived=${archived}`),
  createTerm: (b: { months: number; label: string }) => apiRequest<CommitmentTermRow>('POST', '/v1/commitment-terms', b),
  updateTerm: (months: number, b: { label?: string; archived?: boolean }) => apiRequest<CommitmentTermRow>('PUT', `/v1/commitment-terms/${months}`, b),

  templates: () => apiRequest<{ items: ContractTemplateOption[] }>('GET', '/v1/templates'),
};
