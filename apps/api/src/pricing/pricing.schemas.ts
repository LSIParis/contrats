import { z } from 'zod';

/**
 * Schémas Zod de l'API de tarification (04-tarification.md §17).
 *
 * Ils reproduisent les types d'ENTRÉE du moteur (@lsi/pricing, types.ts) :
 * un barème enregistré est exactement ce que le moteur calculera. Le moteur
 * reste juge de la cohérence fine (type × mode, paliers, remises, formules) ;
 * l'API refuse ici tout ce qui est mal formé, et l'ACTIVATION d'une version
 * rejoue le moteur pour refuser un barème incalculable.
 *
 * Montants : chaînes décimales en EUROS (« 1250 », « 0.0125 »), point
 * décimal, au plus 6 décimales. Jamais de nombre JSON pour un montant : un
 * double IEEE ne représente pas 0,1 € exactement. Les totaux renvoyés sont des
 * chaînes d'entiers en CENTIMES (« 128867 »).
 */

/** Décimal positif ou nul, ≤ 6 décimales (prix unitaire, quantité). */
export const Dec6 = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'décimal attendu (point décimal, ≤ 6 décimales), ex. « 1250.50 »');
/** Pourcentage 0–100, ≤ 2 décimales (TVA). */
export const Percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'pourcentage attendu, ex. « 20 » ou « 5.5 »')
  .refine((v) => Number(v) <= 100, 'au plus 100');
/** Pourcentage de remise / seuil (≤ 4 décimales). */
export const PercentFine = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'pourcentage attendu');
/** Décimal signé (constantes de formule). */
export const SignedDec = z.string().regex(/^-?\d{1,14}(\.\d{1,10})?$/, 'décimal attendu');
export const IsoDate = z.iso.date();
export const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'période « YYYY-MM » attendue');
/** Valeur d'indice (colonne numeric(18,6)). */
export const IndexValue = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'valeur d’indice attendue (≤ 6 décimales)');

export const LineKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, 'clé de ligne : lettres, chiffres, « _ . : - », 64 max');
export const IndexCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'code d’indice en MAJUSCULES, ex. « SYNTEC »');
export const RuleCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'code de règle : lettres, chiffres, « _ . - »');

const IndexLookup = z.enum(['LATEST_PUBLISHED', 'EXACT_PERIOD']);

export const TierTableSchema = z
  .object({
    mode: z.enum(['GRADUATED', 'VOLUME']),
    tiers: z.array(z.object({ upTo: Dec6.nullable(), unitPrice: Dec6 }).strict()).min(1).max(50),
  })
  .strict();

export const RevisionSchema = z
  .object({
    indexCode: IndexCode,
    a: Dec6,
    b: Dec6,
    referenceDate: IsoDate,
    revisionDate: IsoDate,
    lookup: IndexLookup.optional(),
  })
  .strict();

const IndexBindingSchema = z
  .object({
    indexCode: IndexCode,
    date: z.union([IsoDate, z.literal('PRICING_DATE')]),
    lookup: IndexLookup.optional(),
  })
  .strict();

export const FormulaSchema = z
  .object({
    expression: z.string().min(1).max(1000),
    basePrice: Dec6.optional(),
    variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/), SignedDec).optional(),
    indexVariables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/), IndexBindingSchema).optional(),
  })
  .strict();

export const RuleRefSchema = z
  .object({ priceRuleId: RuleCode, adjustmentRuleIds: z.array(RuleCode).max(10).optional() })
  .strict();

export const DiscountSchema = z
  .object({
    type: z.enum(['PERCENT', 'AMOUNT']),
    value: Dec6,
    appliesTo: z.union([
      z.object({ scope: z.literal('LINES'), lineIds: z.array(LineKey).min(1).max(100) }).strict(),
      z.object({ scope: z.literal('SUBTOTAL') }).strict(),
    ]),
  })
  .strict();

export const LineInputSchema = z
  .object({
    lineKey: LineKey,
    articleCode: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(300),
    unit: z.string().trim().min(1).max(40),
    kind: z.enum(['FLAT_MONTHLY', 'FLAT_YEARLY', 'UNIT', 'HOURLY', 'HOUR_PACK', 'SETUP_FEE', 'TIERED', 'DISCOUNT']),
    mode: z.enum(['MANUAL', 'RULE', 'FORMULA']),
    recurrence: z.enum(['MONTHLY', 'YEARLY', 'ONE_OFF']).nullable().optional(),
    vatRatePercent: Percent,
    /** FIXED (défaut, quantité saisie, défaut « 1 ») ou PROVIDER (QuantityProvider). */
    quantitySource: z.enum(['FIXED', 'PROVIDER']).default('FIXED'),
    quantity: Dec6.optional(),
    providerArticleCode: z.string().trim().min(1).max(64).optional(),
    unitPrice: Dec6.optional(),
    tiers: TierTableSchema.optional(),
    rule: RuleRefSchema.optional(),
    formula: FormulaSchema.optional(),
    revision: RevisionSchema.optional(),
    hourPack: z.object({ hoursPerPack: Dec6 }).strict().optional(),
    discount: DiscountSchema.optional(),
  })
  .strict()
  .refine((l) => l.quantitySource === 'FIXED' || l.quantity === undefined, {
    message: 'Une quantité fournie (PROVIDER) ne se saisit pas.',
    path: ['quantity'],
  })
  .refine((l) => l.quantitySource === 'PROVIDER' || l.providerArticleCode === undefined, {
    message: 'providerArticleCode n’a de sens que pour une quantité PROVIDER.',
    path: ['providerArticleCode'],
  });
export type LineInput = z.infer<typeof LineInputSchema>;

const Lines = z
  .array(LineInputSchema)
  .max(200)
  .refine((ls) => new Set(ls.map((l) => l.lineKey)).size === ls.length, 'Clé de ligne en double dans le barème.');

const ScheduleFields = {
  validFrom: IsoDate,
  validTo: IsoDate.nullable().optional(),
  commitmentMonths: z.number().int().min(1).max(240).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
};

/** Nouvelle version (brouillon) : lignes fournies, ou recopiées d'une version existante (clés conservées). */
export const CreateScheduleSchema = z
  .object({ ...ScheduleFields, lines: Lines.optional(), copyFromVersion: z.number().int().positive().optional() })
  .strict()
  .refine((s) => (s.lines === undefined) !== (s.copyFromVersion === undefined), {
    message: 'Fournir soit `lines`, soit `copyFromVersion`.',
    path: ['lines'],
  })
  .refine((s) => !s.validTo || s.validTo >= s.validFrom, { message: 'validTo précède validFrom.', path: ['validTo'] });
export type CreateSchedule = z.infer<typeof CreateScheduleSchema>;

/** Remplacement complet d'un brouillon. */
export const UpdateScheduleSchema = z
  .object({ ...ScheduleFields, lines: Lines })
  .strict()
  .refine((s) => !s.validTo || s.validTo >= s.validFrom, { message: 'validTo précède validFrom.', path: ['validTo'] });
export type UpdateSchedule = z.infer<typeof UpdateScheduleSchema>;

const BoolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const PricingQuerySchema = z
  .object({
    /** Date calendaire (Europe/Paris) ; défaut : aujourd'hui. */
    at: IsoDate.optional(),
    trace: BoolQuery.optional(),
    /** Prévisualise UNE version (brouillon compris), sans les autres. */
    version: z.string().regex(/^\d{1,6}$/).transform(Number).optional(),
  })
  .strict();
export type PricingQuery = z.infer<typeof PricingQuerySchema>;

export const SimulateSchema = z
  .object({
    at: IsoDate,
    beforeDate: IsoDate.optional(),
    trace: z.boolean().optional(),
    changes: z
      .object({
        indexValues: z
          .array(z.object({ indexCode: IndexCode, period: Period, value: IndexValue, publishedAt: IsoDate.optional() }).strict())
          .max(50)
          .optional(),
        quantities: z.array(z.object({ lineId: LineKey, quantity: Dec6 }).strict()).max(200).optional(),
        linePrices: z.array(z.object({ lineId: LineKey, unitPrice: Dec6 }).strict()).max(200).optional(),
      })
      .strict(),
  })
  .strict();
export type SimulateBody = z.infer<typeof SimulateSchema>;

export const QuoteSchema = z
  .object({
    /** Contrat dont le barème fait foi ; sinon le client (un seul contrat portant l'article), sinon le catalogue. */
    contractId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    articleCode: z.string().trim().min(1).max(64),
    quantity: Dec6,
    date: IsoDate.optional(),
    /** Catalogue seulement : règle de grille à utiliser si plusieurs portent l'article. */
    ruleCode: RuleCode.optional(),
    vatRatePercent: Percent.optional(),
  })
  .strict();
export type QuoteBody = z.infer<typeof QuoteSchema>;

export const CreateOverrideSchema = z
  .object({
    lineKey: LineKey,
    unitPrice: Dec6,
    validFrom: IsoDate,
    validTo: IsoDate,
    reason: z.string().trim().min(1, 'Le motif est obligatoire.').max(2000),
  })
  .strict()
  .refine((o) => o.validTo >= o.validFrom, { message: 'validTo précède validFrom.', path: ['validTo'] });
export type CreateOverride = z.infer<typeof CreateOverrideSchema>;

export const DecisionSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict();
export const RejectSchema = z.object({ reason: z.string().trim().min(1, 'Le motif du refus est obligatoire.').max(2000) }).strict();

// ---------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------

export const ConnectorConfigSchema = z
  .object({
    type: z.literal('CSV'),
    delimiter: z.enum([';', ',', '\t']).optional(),
    /** Accepter la virgule décimale (« 321,5 ») — seulement si le séparateur n'est pas la virgule. */
    decimalComma: z.boolean().optional(),
  })
  .strict();

export const CreateIndexSchema = z
  .object({
    code: IndexCode,
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    connector: ConnectorConfigSchema.nullable().optional(),
  })
  .strict();
export type CreateIndex = z.infer<typeof CreateIndexSchema>;

export const AddIndexValueSchema = z
  .object({
    period: Period,
    value: IndexValue,
    publishedAt: IsoDate,
    /** Correction : identifiant de la valeur remplacée (pointe de chaîne de la même période). */
    supersedesId: z.uuid().optional(),
    correctionReason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((v) => !v.supersedesId || v.correctionReason, { message: 'Une correction exige son motif.', path: ['correctionReason'] })
  .refine((v) => v.publishedAt >= `${v.period}-01`, { message: 'Une valeur ne peut pas être publiée avant sa période.', path: ['publishedAt'] });
export type AddIndexValue = z.infer<typeof AddIndexValueSchema>;

// ---------------------------------------------------------------------------
// Catalogue de règles — `definition` par type (types PricingRule du moteur,
// sans id / type / label, portés par les colonnes).
// ---------------------------------------------------------------------------

export const RuleDefinitionSchemas = {
  GRID: z
    .object({
      entries: z
        .array(z.object({ articleCode: z.string().trim().min(1).max(64), unitPrice: Dec6 }).strict())
        .max(1000)
        .refine((es) => new Set(es.map((e) => e.articleCode)).size === es.length, 'Article en double dans la grille.'),
    })
    .strict(),
  TIERS: z.object({ table: TierTableSchema }).strict(),
  VOLUME_DISCOUNT: z
    .object({ thresholds: z.array(z.object({ minQuantity: Dec6, percent: PercentFine }).strict()).min(1).max(50) })
    .strict(),
  COMMITMENT_DISCOUNT: z
    .object({
      thresholds: z.array(z.object({ minMonths: z.number().int().min(0).max(240), percent: PercentFine }).strict()).min(1).max(50),
    })
    .strict(),
} as const;
export type RuleType = keyof typeof RuleDefinitionSchemas;

export const CreateRuleSchema = z
  .object({
    code: RuleCode,
    type: z.enum(['GRID', 'TIERS', 'VOLUME_DISCOUNT', 'COMMITMENT_DISCOUNT']),
    label: z.string().trim().min(1).max(200),
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CreateRule = z.infer<typeof CreateRuleSchema>;

export const UpdateRuleSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((u) => u.label !== undefined || u.definition !== undefined, 'Rien à modifier.');
export type UpdateRule = z.infer<typeof UpdateRuleSchema>;
