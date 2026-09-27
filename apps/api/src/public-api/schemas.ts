import { z } from 'zod';
import { QuoteSchema } from '../pricing/pricing.schemas.js';

/**
 * Schémas de l'API publique /api/v1 — SOURCE UNIQUE : validation des
 * entrées ET description OpenAPI 3.1 (`z.toJSONSchema`), donc ET client
 * TypeScript généré. Un champ ajouté ici apparaît partout à la fois.
 */

const IsoDate = z.iso.date().describe('Date calendaire AAAA-MM-JJ');
const Uuid = z.uuid();

export const CONTRACT_STATUSES = [
  'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SENT_TO_CLIENT', 'IN_NEGOTIATION', 'ACCEPTED',
  'PENDING_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNATURE_EXPIRED', 'SIGNED', 'ACTIVE', 'RENEWAL_DUE',
  'TERMINATION_PENDING', 'EXPIRED', 'TERMINATED', 'RENEWED', 'CANCELLED', 'DECLINED', 'IMPORTED_PENDING_VALIDATION',
] as const;

// --- Requêtes -----------------------------------------------------------------

export const PageQuery = z.object({
  cursor: z.string().max(500).optional().describe('Curseur opaque renvoyé par la page précédente (`nextCursor`).'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ClientContractsQuery = PageQuery.extend({
  status: z.string().regex(/^[A-Z_]+(,[A-Z_]+)*$/).optional().describe('Statuts séparés par des virgules, ex. `ACTIVE,RENEWAL_DUE`.'),
  type: z.enum(['MAIN', 'AMENDMENT']).optional(),
}).strict();

export const PricingAtQuery = z.object({
  at: IsoDate.optional().describe('Date d’application ; défaut : aujourd’hui (Europe/Paris).'),
  trace: z.enum(['true', 'false']).optional().describe('`true` : inclut la trace de calcul.'),
}).strict();

export const DeadlinesQuery = PageQuery.extend({
  from: IsoDate.optional().describe('Défaut : aujourd’hui.'),
  to: IsoDate.optional().describe('Défaut : `from` + 90 jours. Fenêtre maximale : 366 jours.'),
  kind: z.string().regex(/^[A-Z_]+(,[A-Z_]+)*$/).optional(),
}).strict();

export { QuoteSchema };

export { CreateWebhookBody } from '../webhooks-out/webhooks-admin.dto.js';

// --- Réponses -----------------------------------------------------------------

export const CustomerRef = z.object({
  id: Uuid,
  name: z.string(),
  externalRef: z.string().nullable(),
  siren: z.string().nullable(),
});

export const Contract = z.object({
  id: Uuid,
  reference: z.string(),
  title: z.string(),
  type: z.enum(['MAIN', 'AMENDMENT']),
  status: z.enum(CONTRACT_STATUSES),
  origin: z.enum(['NATIVE', 'IMPORTED', 'AI']),
  category: z.string(),
  customer: CustomerRef,
  parentContractId: Uuid.nullable(),
  currency: z.string(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  renewalMode: z.enum(['NONE', 'TACIT', 'EXPRESS']),
  signatureMode: z.enum(['PDF', 'TEMPLATE']).nullable().describe('Mode de la dernière demande de signature ; null si aucune.'),
  signedAt: z.iso.datetime().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const ContractPage = z.object({ data: z.array(Contract), nextCursor: z.string().nullable() });

export const ContractDates = z.object({
  contractId: Uuid,
  effectiveDate: IsoDate.nullable().describe('Date d’effet.'),
  currentPeriodEnd: IsoDate.nullable().describe('Fin de la période en cours ; null pour une durée indéterminée.'),
  noticeDeadline: IsoDate.nullable().describe('Date limite de dénonciation de la période en cours.'),
  nextPriceRevision: IsoDate.nullable(),
  nextRenewal: IsoDate.nullable().describe('Début de la prochaine période si le contrat se renouvelle.'),
  renewalMode: z.enum(['NONE', 'TACIT', 'EXPRESS']),
  terminationEffectiveDate: IsoDate.nullable(),
});

export const Deadline = z.object({
  id: Uuid,
  contractId: Uuid,
  customerId: Uuid,
  kind: z.string(),
  dueDate: IsoDate,
  status: z.enum(['OPEN', 'DONE']),
  details: z.unknown().nullable(),
});
export const DeadlinePage = z.object({ data: z.array(Deadline), nextCursor: z.string().nullable() });

export const Pricing = z
  .object({ contractId: Uuid.optional(), at: IsoDate.optional(), currency: z.string().optional(), lines: z.array(z.record(z.string(), z.unknown())).optional() })
  .loose()
  .describe('Barème à la date : montants en centimes, en chaînes (précision exacte). Détail : 04-tarification.md.');
export const Quote = z.object({}).loose().describe('Devis : prix unitaire, total HT/TTC en centimes (chaînes), règle appliquée, trace.');

export const Webhook = z.object({}).loose();

export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
}).loose().describe('Erreur RFC 9457 (`application/problem+json`).');
