import { z } from 'zod';
import { GRID_RECURRENCE_CODES, MAX_COMMITMENT_MONTHS, PRICE_UNIT_CODES } from '@lsi/domain';
import { Dec6, IsoDate, Percent } from '../pricing/pricing.schemas.js';

/**
 * Schémas Zod des types de contrats et grilles tarifaires
 * (docs/contrats/13-types-contrats.md). Montants : chaînes décimales en euros,
 * comme la tarification (pricing.schemas.ts).
 */

export const KindPrefix = z.string().regex(/^[A-Z0-9]{2,6}$/, 'préfixe : 2 à 6 caractères, MAJUSCULES et chiffres, ex. « M365 »');
export const ItemCode = z.string().regex(/^[A-Z0-9]{2,6}-\d{4,}$/, 'code de base attendu, ex. « M365-0003 »');
export const VariantCode = z.string().regex(/^[A-Z0-9]{2,6}-\d{4,}-E\d{2}$/, 'code de version attendu, ex. « M365-0003-E12 »');
export const Months = z.coerce.number().int().min(0).max(MAX_COMMITMENT_MONTHS);
const Label = z.string().trim().min(1).max(200);
const Description = z.string().trim().max(4000).nullable();

export const CreateKindSchema = z
  .object({
    label: Label,
    prefix: KindPrefix,
    description: Description.optional(),
    sortOrder: z.number().int().optional(),
    contractTemplateId: z.uuid().nullable().optional(),
  })
  .strict();
export type CreateKind = z.infer<typeof CreateKindSchema>;

export const UpdateKindSchema = CreateKindSchema.partial().strict();
export type UpdateKind = z.infer<typeof UpdateKindSchema>;

export const CreateTermSchema = z.object({ months: Months, label: Label }).strict();
export type CreateTerm = z.infer<typeof CreateTermSchema>;

export const UpdateTermSchema = z.object({ label: Label.optional(), archived: z.boolean().optional() }).strict();
export type UpdateTerm = z.infer<typeof UpdateTermSchema>;

/**
 * Prix d'une durée. `unitPrice: null` = version non proposée pour cette durée
 * (archivée si elle existait) ; durée absente de la liste = inchangée.
 */
export const DurationPriceSchema = z
  .object({ months: Months, unitPrice: Dec6.nullable(), purchasePrice: Dec6.nullable().optional() })
  .strict();
export type DurationPrice = z.infer<typeof DurationPriceSchema>;

export const SetPricesSchema = z
  .object({
    /** Date d'effet ; par défaut aujourd'hui (Europe/Paris). */
    effectiveFrom: IsoDate.optional(),
    prices: z.array(DurationPriceSchema).min(1).max(MAX_COMMITMENT_MONTHS + 1),
  })
  .strict()
  .refine((b) => new Set(b.prices.map((p) => p.months)).size === b.prices.length, 'une même durée apparaît deux fois');
export type SetPrices = z.infer<typeof SetPricesSchema>;

const ItemFields = {
  label: Label,
  description: Description.optional(),
  unit: z.enum(PRICE_UNIT_CODES),
  recurrence: z.enum(GRID_RECURRENCE_CODES),
  vatRatePercent: Percent,
  sortOrder: z.number().int().optional(),
};

export const CreateItemSchema = z
  .object({ ...ItemFields, effectiveFrom: IsoDate.optional(), prices: z.array(DurationPriceSchema).max(MAX_COMMITMENT_MONTHS + 1).optional() })
  .strict();
export type CreateItem = z.infer<typeof CreateItemSchema>;

export const UpdateItemSchema = z.object(ItemFields).partial().strict();
export type UpdateItem = z.infer<typeof UpdateItemSchema>;

export const GridQuery = z.object({ on: IsoDate.optional(), archived: z.enum(['true', 'false']).optional() }).strict();
export const ListQuery = z.object({ archived: z.enum(['true', 'false']).optional() }).strict();

export const SearchQuery = z
  .object({
    kindId: z.uuid().optional(),
    months: Months.optional(),
    q: z.string().trim().max(100).optional(),
    on: IsoDate.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type Search = z.infer<typeof SearchQuery>;

export const ImportFields = z
  .object({ effectiveFrom: IsoDate.optional(), dryRun: z.enum(['true', 'false']).optional() })
  .strict();
