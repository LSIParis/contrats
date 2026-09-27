import { z } from 'zod';

/**
 * Registre des événements sortants et schémas de leurs charges utiles.
 * (brief §8, docs/contrats/07-api.md §Webhooks sortants)
 *
 * CES SCHÉMAS SONT UN CONTRAT PUBLIC : ils seront exportés tels quels dans
 * l'OpenAPI de l'API publique (lot 7, `z.toJSONSchema()`). Règles :
 *   - on AJOUTE des champs optionnels ou des types d'événements ; on ne
 *     renomme ni ne retire jamais un champ (un consommateur casserait) ;
 *   - MINIMISATION (docs/contrats/08-securite-rgpd.md) : identifiants,
 *     références, dates et statuts seulement. Aucun nom, e-mail, téléphone,
 *     adresse, titre libre, montant ni contenu contractuel. Le consommateur
 *     qui a besoin de plus relit l'API publique avec ses propres droits.
 *
 * Ajouter un événement : une entrée dans `WEBHOOK_EVENT_SCHEMAS` (+ un
 * producteur). Rien d'autre : la validation des abonnements, la publication
 * et la documentation OpenAPI suivent ce registre.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue');
const isoInstant = z.string().datetime({ offset: true });

const CONTRACT_STATUSES = [
  'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SENT_TO_CLIENT', 'IN_NEGOTIATION',
  'ACCEPTED', 'PENDING_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'SIGNATURE_EXPIRED', 'ACTIVE',
  'RENEWAL_DUE', 'RENEWED', 'TERMINATION_PENDING', 'TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED',
  'IMPORTED_PENDING_VALIDATION',
] as const;
// Un statut ajouté plus tard ne doit pas faire échouer la publication d'un
// événement : le schéma documente les valeurs connues mais accepte toute
// chaîne en MAJUSCULES (les consommateurs doivent tolérer l'inconnu).
const contractStatus = z.union([z.enum(CONTRACT_STATUSES), z.string().regex(/^[A-Z_]+$/)]);

/** Photographie minimale d'un contrat, commune aux événements `contract.*`. */
export const ContractRefSchema = z
  .object({
    id: z.string().uuid(),
    /** Référence métier lisible (ex. « CT-2026-0042 »). */
    reference: z.string(),
    type: z.enum(['MAIN', 'AMENDMENT']),
    status: contractStatus,
    previousStatus: contractStatus.nullable(),
    customerId: z.string().uuid(),
    /** Référence du client dans la suite (Client Help), si renseignée. */
    customerExternalRef: z.string().nullable(),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    signedAt: isoInstant.nullable(),
    activatedAt: isoInstant.nullable(),
    terminatedAt: isoInstant.nullable(),
    terminationEffectiveDate: isoDate.nullable(),
  })
  .strict();
export type ContractRef = z.infer<typeof ContractRefSchema>;

export const ContractEventDataSchema = z.object({ contract: ContractRefSchema }).strict();
export type ContractEventData = z.infer<typeof ContractEventDataSchema>;

/**
 * `pricing.revised` : révision d'un barème (indexation…). Le producteur est
 * le lot 3 (tarification) ; seuls des identifiants et la date d'effet sont
 * publiés — les montants se relisent par `GET /api/v1/contracts/{id}/pricing`.
 */
export const PricingRevisedDataSchema = z
  .object({
    contract: z
      .object({
        id: z.string().uuid(),
        reference: z.string(),
        customerId: z.string().uuid(),
        customerExternalRef: z.string().nullable(),
      })
      .strict(),
    revision: z
      .object({
        id: z.string().uuid(),
        scheduleId: z.string().uuid().nullable(),
        effectiveDate: isoDate,
        /** Motif codé (ex. INDEXATION, AMENDMENT, MANUAL) — jamais un texte libre. */
        reason: z.string().regex(/^[A-Z_]{2,40}$/),
      })
      .strict(),
  })
  .strict();
export type PricingRevisedData = z.infer<typeof PricingRevisedDataSchema>;

/**
 * `proposal.*` (lot 9, brief §12.9) : photographie MINIMALE d'une proposition —
 * identifiants, numéro, statut, dates. Ni montant, ni titre libre, ni contact :
 * le consommateur relit `GET /api/v1/proposals/{id}` avec ses propres droits.
 */
const PROPOSAL_STATUSES = [
  'DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED', 'PENDING_SIGNATURE',
  'SIGNED', 'CONVERTED', 'EXPIRED', 'DECLINED', 'WITHDRAWN',
] as const;
const proposalStatus = z.union([z.enum(PROPOSAL_STATUSES), z.string().regex(/^[A-Z_]+$/)]);

export const ProposalRefSchema = z
  .object({
    id: z.string().uuid(),
    /** Numéro métier (« PROP-2026-0042 »). */
    number: z.string(),
    status: proposalStatus,
    previousStatus: proposalStatus.nullable(),
    customerId: z.string().uuid(),
    customerExternalRef: z.string().nullable(),
    versionNumber: z.number().int().positive().nullable(),
    expiresAt: isoInstant.nullable(),
    /** Motif codé du refus (PRICE, COMPETITOR…) — jamais le texte libre. */
    declineReasonCode: z.string().regex(/^[A-Z_]{2,40}$/).nullable(),
    /** Contrat généré (proposal.converted). */
    contractId: z.string().uuid().nullable(),
  })
  .strict();
export type ProposalRef = z.infer<typeof ProposalRefSchema>;

export const ProposalEventDataSchema = z.object({ proposal: ProposalRefSchema }).strict();
export type ProposalEventData = z.infer<typeof ProposalEventDataSchema>;

/** `ping` : envoyé par le bouton « tester » d'un abonnement. */
export const PingDataSchema = z
  .object({ subscriptionId: z.string().uuid(), message: z.literal('ping') })
  .strict();

export const WEBHOOK_EVENT_SCHEMAS = {
  'contract.activated': ContractEventDataSchema,
  'contract.signed': ContractEventDataSchema,
  'contract.renewal_due': ContractEventDataSchema,
  'contract.renewed': ContractEventDataSchema,
  'contract.terminated': ContractEventDataSchema,
  'pricing.revised': PricingRevisedDataSchema,
  // Lot 9 — propositions commerciales.
  'proposal.sent': ProposalEventDataSchema,
  'proposal.viewed': ProposalEventDataSchema,
  'proposal.accepted': ProposalEventDataSchema,
  'proposal.signed': ProposalEventDataSchema,
  'proposal.declined': ProposalEventDataSchema,
  'proposal.expired': ProposalEventDataSchema,
  'proposal.converted': ProposalEventDataSchema,
} as const;

export type WebhookEventType = keyof typeof WEBHOOK_EVENT_SCHEMAS;
/** Types auxquels un abonnement peut s'inscrire (`ping` est implicite). */
export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_SCHEMAS) as WebhookEventType[];
export const isWebhookEventType = (t: string): t is WebhookEventType => Object.hasOwn(WEBHOOK_EVENT_SCHEMAS, t);

export type WebhookEventData<T extends WebhookEventType> = z.infer<(typeof WEBHOOK_EVENT_SCHEMAS)[T]>;

/**
 * Enveloppe du corps HTTP POSTé au consommateur. `id` est l'identifiant de
 * l'ÉVÉNEMENT (stable d'une tentative à l'autre : clé d'idempotence côté
 * consommateur) ; l'identifiant de LIVRAISON est dans `X-Contrats-Delivery`.
 */
export const WebhookEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    occurredAt: isoInstant,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Constructeurs de charges utiles (stables : un seul endroit décide des champs)
// ---------------------------------------------------------------------------

const dateOnly = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const instant = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Ligne `contracts` (Prisma) — seuls les champs lus ici sont requis. */
export interface ContractRowForEvent {
  id: string;
  reference: string;
  type: string;
  status: string;
  customerId: string;
  startDate: Date | null;
  endDate: Date | null;
  signedAt: Date | null;
  activatedAt: Date | null;
  terminatedAt: Date | null;
  terminationEffectiveDate?: Date | null;
}

export function buildContractEventData(
  c: ContractRowForEvent,
  previousStatus: string | null,
  customerExternalRef: string | null,
): ContractEventData {
  return ContractEventDataSchema.parse({
    contract: {
      id: c.id,
      reference: c.reference,
      type: c.type,
      status: c.status,
      previousStatus,
      customerId: c.customerId,
      customerExternalRef,
      startDate: dateOnly(c.startDate),
      endDate: dateOnly(c.endDate),
      signedAt: instant(c.signedAt),
      activatedAt: instant(c.activatedAt),
      terminatedAt: instant(c.terminatedAt),
      terminationEffectiveDate: dateOnly(c.terminationEffectiveDate ?? null),
    },
  });
}

export function buildPricingRevisedData(input: PricingRevisedData): PricingRevisedData {
  return PricingRevisedDataSchema.parse(input);
}

/** Corps exact envoyé (sérialisé UNE fois : c'est ce texte-là qui est signé). */
export function buildEnvelope(e: { id: string; type: string; occurredAt: Date; payload: unknown }): WebhookEnvelope {
  return { id: e.id, type: e.type, occurredAt: e.occurredAt.toISOString(), data: e.payload as Record<string, unknown> };
}
