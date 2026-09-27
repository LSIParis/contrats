/**
 * Schéma Zod des modèles de proposition livrés en seed.
 * Les fichiers JSON de ce dossier sont la source de vérité ; ce schéma les valide
 * au chargement, avant toute écriture en base.
 *
 * Conventions :
 * - tous les montants sont en centimes HT (entiers) ;
 * - `key` est un identifiant stable (kebab-case), unique dans son périmètre ;
 * - `priceStatus` VALIDATED = repris d'une offre LSI-Maintenance existante,
 *   TO_VALIDATE = valeur indicative, bloque le passage de la proposition à PRÊTE.
 */
import { z } from "zod";

export const Key = z
  .string()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i, "clé kebab-case attendue");

export const Cents = z.number().int().nonnegative();

export const PriceStatus = z.enum(["VALIDATED", "TO_VALIDATE"]);
export type PriceStatus = z.infer<typeof PriceStatus>;

export const Recurrence = z.enum(["ONE_TIME", "MONTHLY", "QUARTERLY", "YEARLY", "INFO"]);
export type Recurrence = z.infer<typeof Recurrence>;

export const LineKind = z.enum([
  "REQUIRED", // toujours incluse (quantité éventuellement 0 si min = 0)
  "OPTIONAL", // case à cocher côté client
  "SETUP", // frais ponctuels, quantité liée à une autre ligne
  "INFO", // tarif affiché, non sélectionnable (hors forfait, jours additionnels)
]);
export type LineKind = z.infer<typeof LineKind>;

/** Balise de fusion autorisée comme quantité par défaut, ex. "{{parc.nbPostes}}". */
export const MergeTag = z.string().regex(/^\{\{[a-zA-Z0-9_.]+\}\}$/, "balise {{a.b}} attendue");

export const Quantity = z
  .object({
    default: z.union([z.number().int().nonnegative(), MergeTag]),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive().optional(),
    /** La quantité ne peut dépasser celle d'une autre ligne (ex. postes Premium ≤ postes). */
    maxFrom: Key.optional(),
    /** Quantité strictement égale à celle d'une autre ligne (frais de mise en service). */
    linkedTo: Key.optional(),
    editableByClient: z.boolean(),
  })
  .refine((q) => q.max === undefined || q.max >= q.min, "max < min")
  .refine((q) => !(q.linkedTo && q.editableByClient), "une quantité liée n'est pas modifiable");

/**
 * Prix unitaire : fixe, ou dépendant d'un choix exclusif (engagement, formule).
 * `byChoice` doit couvrir toutes les valeurs du choix référencé.
 */
export const Pricing = z.union([
  z.object({ unitPriceCents: Cents }).strict(),
  z
    .object({
      dependsOn: Key,
      byChoice: z.record(z.string(), Cents),
    })
    .strict(),
]);
export type Pricing = z.infer<typeof Pricing>;

export const Indexation = z
  .object({
    index: z.literal("SYNTEC"),
    a: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
  })
  .refine((i) => Math.abs(i.a + i.b - 1) < 1e-9, "a + b doit valoir 1");

export const PricingLine = z.object({
  key: Key,
  label: z.string().min(3),
  description: z.string().optional(),
  kind: LineKind,
  unit: z.string().min(1),
  recurrence: Recurrence,
  /** Absent pour les lignes INFO sans quantité. */
  quantity: Quantity.optional(),
  pricing: Pricing,
  /** Mention « à partir de » affichée devant le prix. */
  priceFrom: z.boolean().default(false),
  priceStatus: PriceStatus,
  /** Statut par valeur du choix (`pricing.dependsOn`) quand il varie ; prioritaire sur priceStatus. */
  priceStatusByChoice: z.record(z.string(), PriceStatus).optional(),
  priceSource: z.string().min(3),
  /** Ligne de frais de mise en service associée (clé d'une ligne SETUP). */
  setupLineKey: Key.optional(),
  indexation: Indexation.optional(),
  /** Groupe d'affichage dans le tableau (sous-totaux). */
  group: z.enum(["RECURRING", "SETUP", "OPTIONS", "YEARLY", "OUT_OF_SCOPE"]),
});
export type PricingLine = z.infer<typeof PricingLine>;

export const Choice = z.object({
  key: Key,
  label: z.string(),
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
        default: z.boolean().default(false),
        /** Mois d'engagement correspondant, si le choix porte la durée. */
        commitmentMonths: z.number().int().positive().optional(),
      }),
    )
    .min(2),
  editableByClient: z.boolean(),
  priceStatus: PriceStatus.default("VALIDATED"),
  note: z.string().optional(),
});
export type Choice = z.infer<typeof Choice>;

const Rule = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MINIMUM_MONTHLY"),
    key: Key,
    amountCents: Cents,
    label: z.string(),
    priceStatus: PriceStatus,
    priceSource: z.string(),
  }),
  z.object({
    type: z.literal("REQUIRES"),
    key: Key,
    line: Key,
    requires: z.array(Key).min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("REQUIRED_IF_ANY"),
    key: Key,
    line: Key,
    ifAny: z.array(Key).min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("AUTO_INCLUDE"),
    key: Key,
    line: Key,
    when: Key,
  }),
  z.object({
    type: z.literal("AT_LEAST_ONE"),
    key: Key,
    lines: z.array(Key).min(2),
    message: z.string(),
  }),
  z.object({
    type: z.literal("DISCOUNT_PERCENT"),
    key: Key,
    percent: z.number().positive().max(100),
    appliesTo: z.array(Key).min(1),
    when: Key,
    label: z.string(),
    priceStatus: PriceStatus,
    priceSource: z.string(),
  }),
  z.object({
    type: z.literal("PRESELECT_CHOICE"),
    key: Key,
    choice: Key,
    field: z.string(),
    ranges: z
      .array(
        z.object({
          min: z.number().int().optional(),
          max: z.number().int().optional(),
          value: z.string(),
        }),
      )
      .min(2),
  }),
]);
export { Rule };
export type Rule = z.infer<typeof Rule>;

export const SectionKind = z.enum([
  "COVER",
  "LIBRARY", // contenu partagé de la bibliothèque, référencé par libraryKey
  "TEXT", // texte propre au modèle
  "CLIENT_INPUT", // bloc à compléter par le commercial, assistable par l'IA
  "PRICING", // tableau de prix interactif
  "TERMS", // CGV versionnées, figées à l'envoi
  "SIGNATURE",
]);

export const Section = z
  .object({
    key: Key,
    title: z.string().min(2),
    kind: SectionKind,
    /** Markdown avec balises de fusion {{…}}. */
    body: z.string().optional(),
    libraryKey: Key.optional(),
    /** Consignes au commercial et à l'IA pour les blocs CLIENT_INPUT. */
    guidance: z.string().optional(),
    aiAssist: z.boolean().default(false),
    optional: z.boolean().default(false),
    /** Contenu contenant des engagements chiffrés à valider (délais, SLA). */
    validationStatus: PriceStatus.default("VALIDATED"),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "LIBRARY" && !s.libraryKey)
      ctx.addIssue({ code: "custom", message: `section ${s.key} : libraryKey requis` });
    if (["TEXT", "COVER"].includes(s.kind) && !s.body)
      ctx.addIssue({ code: "custom", message: `section ${s.key} : body requis` });
    if (s.kind === "CLIENT_INPUT" && !s.guidance)
      ctx.addIssue({ code: "custom", message: `section ${s.key} : guidance requis` });
  });
export type Section = z.infer<typeof Section>;

export const ControlCase = z.object({
  name: z.string(),
  choices: z.record(z.string(), z.string()),
  quantities: z.record(z.string(), z.number().int().nonnegative()),
  selectedOptions: z.array(Key).default([]),
  expected: z.object({
    monthlyCents: Cents.optional(),
    oneTimeCents: Cents.optional(),
    commitmentTotalCents: Cents.optional(),
    yearlyCents: Cents.optional(),
  }),
});
export type ControlCase = z.infer<typeof ControlCase>;

export const ProposalTemplateSeed = z.object({
  $schema: z.string().optional(),
  slug: Key,
  seedVersion: z.number().int().positive(),
  name: z.string().min(3),
  description: z.string(),
  target: z.string(),
  contractTemplateSlug: Key,
  acceptanceMode: z.enum(["DOCUSEAL_SIGNATURE", "CLICK_ACCEPT"]),
  providerCountersign: z.boolean(),
  validityDays: z.number().int().positive(),
  followUps: z.object({
    noOpenAfterDays: z.number().int().positive(),
    noDecisionAfterDays: z.number().int().positive(),
    beforeExpiryDays: z.number().int().positive(),
  }),
  vatRatePercent: z.number().min(0).max(100),
  currency: z.literal("EUR"),
  tags: z.array(z.string()).default([]),
  sections: z.array(Section).min(3),
  pricing: z.object({
    choices: z.array(Choice),
    lines: z.array(PricingLine).min(1),
    rules: z.array(Rule).default([]),
  }),
  controlCases: z.array(ControlCase).default([]),
});
export type ProposalTemplateSeed = z.infer<typeof ProposalTemplateSeed>;

export const LibraryItemSeed = z.object({
  key: Key,
  title: z.string(),
  folder: z.string(),
  body: z.string().min(10),
  seedVersion: z.number().int().positive(),
  requiresLegalReview: z.boolean().default(false),
});
export const ContentLibrarySeed = z.object({
  $schema: z.string().optional(),
  items: z.array(LibraryItemSeed).min(1),
});
export type LibraryItemSeed = z.infer<typeof LibraryItemSeed>;
