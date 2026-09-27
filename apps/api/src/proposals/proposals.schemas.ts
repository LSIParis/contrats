import { z } from 'zod';
import { DECLINE_REASON_CODES } from '@lsi/domain';

/**
 * Schémas Zod des routes « propositions » (validation + future OpenAPI, lot
 * 9.8). Tous `.strict()` : un champ inconnu fait échouer la requête. Aucun
 * identifiant de scope (tenant) n'y figure : il vient de la session (RM-29).
 */

const IsoDay = z.iso.date();
const Uuid = z.string().uuid();
/** Valeurs de fusion saisies : balises du catalogue seulement, valeurs simples. */
const MergeContext = z.record(z.string().regex(/^[a-zA-Z0-9_.]+$/).max(64), z.union([z.string().max(300), z.number().int().nonnegative()]));

export const CreateProposalSchema = z
  .object({
    customerId: Uuid,
    /** Modèle de départ (slug de l'annexe C) ; absent = proposition vierge. */
    templateSlug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(64).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    acceptanceMode: z.enum(['DOCUSEAL_SIGNATURE', 'CLICK_ACCEPT']).optional(),
    mergeContext: MergeContext.optional(),
    /** Contacts du client ajoutés comme destinataires (signataires s'ils ont qualité à signer). */
    contactIds: z.array(Uuid).max(20).optional(),
  })
  .strict();
export type CreateProposal = z.infer<typeof CreateProposalSchema>;

export const UpdateProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    acceptanceMode: z.enum(['DOCUSEAL_SIGNATURE', 'CLICK_ACCEPT']).optional(),
    validityDays: z.number().int().min(1).max(365).optional(),
    fixedExpiryDate: IsoDay.nullable().optional(),
    sensitive: z.boolean().optional(),
    mergeContext: MergeContext.optional(),
    followUpsEnabled: z.boolean().optional(),
    followUpConfig: z
      .object({
        noOpenAfterDays: z.number().int().min(1).max(90),
        noDecisionAfterDays: z.number().int().min(1).max(180),
        beforeExpiryDays: z.number().int().min(1).max(90),
      })
      .strict()
      .nullable()
      .optional(),
    winProbability: z.number().int().min(0).max(100).nullable().optional(),
    /** Date d'effet souhaitée, reprise par le contrat généré. */
    desiredStartDate: IsoDay.nullable().optional(),
  })
  .strict();
export type UpdateProposal = z.infer<typeof UpdateProposalSchema>;

export const RecipientSchema = z
  .object({
    contactId: Uuid.nullable().optional(),
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(254),
    jobTitle: z.string().trim().max(200).nullable().optional(),
    role: z.enum(['DECISION_MAKER', 'SIGNER', 'READER']),
    signingOrder: z.number().int().min(0).max(20).optional(),
  })
  .strict();
export type RecipientInput = z.infer<typeof RecipientSchema>;

export const SelectionSchema = z
  .object({
    choices: z.record(z.string().max(64), z.string().max(40)).optional(),
    quantities: z.record(z.string().max(64), z.number().int().min(0).max(100_000)).optional(),
    selectedOptions: z.array(z.string().max(64)).max(100).optional(),
  })
  .strict();
export type SelectionBody = z.infer<typeof SelectionSchema>;

export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();
export const OptionalReasonSchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();
export const ReactivateSchema = z.object({ reason: z.string().trim().min(3).max(2000), expiresOn: IsoDay }).strict();
export const ResendSchema = z.object({ recipientId: Uuid.optional() }).strict();
export const ReplySchema = z.object({ body: z.string().trim().min(1).max(5000), parentId: Uuid.optional(), sectionKey: z.string().max(64).optional() }).strict();

export const ListProposalsSchema = z
  .object({
    status: z.string().regex(/^[A-Z_]+(,[A-Z_]+)*$/).optional(),
    customerId: Uuid.optional(),
    mine: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type ListProposals = z.infer<typeof ListProposalsSchema>;

// --- Page publique ------------------------------------------------------------

export const ViewEventsSchema = z
  .object({
    /** Identifiant aléatoire du navigateur (stockage local), haché côté serveur. */
    viewerId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    events: z
      .array(
        z
          .object({
            type: z.enum(['OPENED', 'SECTION_VIEWED', 'PDF_DOWNLOADED']),
            sectionKey: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(64).optional(),
            durationMs: z.number().int().min(0).max(3_600_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ViewEventsBody = z.infer<typeof ViewEventsSchema>;

export const PublicCommentSchema = z
  .object({ body: z.string().trim().min(1).max(5000), sectionKey: z.string().max(64).optional() })
  .strict();

export const DeclineSchema = z
  .object({ reasonCode: z.enum(DECLINE_REASON_CODES), reason: z.string().trim().max(2000).optional() })
  .strict();

export const OtpVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export const AcceptSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    jobTitle: z.string().trim().min(2).max(200),
    email: z.string().trim().toLowerCase().email().max(254),
    /** Case « j'ai lu et j'accepte » : doit être cochée. */
    consent: z.literal(true),
  })
  .strict();
export type AcceptBody = z.infer<typeof AcceptSchema>;

// --- Administration -------------------------------------------------------------

export const ValidatePendingSchema = z
  .object({
    templateSlug: z.string().max(64),
    scope: z.enum(['LINE', 'RULE', 'SECTION', 'CHOICE']),
    key: z.string().max(64),
    choiceValue: z.string().max(40).optional(),
  })
  .strict();

export const ValidatePriceSchema = z
  .object({ scope: z.enum(['LINE', 'RULE', 'CHOICE']), key: z.string().max(64), choiceValue: z.string().max(40).optional() })
  .strict();

export const UpdateTemplateSchema = z
  .object({
    name: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    target: z.string().trim().max(2000).optional(),
    validityDays: z.number().int().min(1).max(365).optional(),
    acceptanceMode: z.enum(['DOCUSEAL_SIGNATURE', 'CLICK_ACCEPT']).optional(),
    providerCountersign: z.boolean().optional(),
    signedProposalIsContract: z.boolean().optional(),
  })
  .strict();

export const UpdateTemplateLineSchema = z
  .object({
    label: z.string().trim().min(3).max(300).optional(),
    /** Prix en centimes HT : { unitPriceCents } ou { dependsOn, byChoice }. */
    pricing: z
      .union([
        z.object({ unitPriceCents: z.number().int().nonnegative() }).strict(),
        z.object({ dependsOn: z.string().max(64), byChoice: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
      ])
      .optional(),
    priceSource: z.string().trim().min(3).max(300).optional(),
  })
  .strict();

export const LibraryItemSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(64),
    title: z.string().trim().min(1).max(200),
    folder: z.string().trim().min(1).max(100),
    body: z.string().min(10).max(50_000),
    requiresLegalReview: z.boolean().optional(),
  })
  .strict();
export const UpdateLibraryItemSchema = LibraryItemSchema.omit({ key: true }).partial().strict();

export const TermsSchema = z.object({ title: z.string().trim().min(3).max(200), body: z.string().min(20).max(200_000) }).strict();

export const ContractTemplateSlugSchema = z
  .object({ slug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(64).nullable() })
  .strict();
