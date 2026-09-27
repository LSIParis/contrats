import { z } from 'zod';
import { API_SCOPES, type ApiScope } from './api-key.js';
import {
  ClientContractsQuery, Contract, ContractDates, ContractPage, CreateWebhookBody, Deadline, DeadlinePage, DeadlinesQuery,
  Pricing, PricingAtQuery, Problem, Proposal, ProposalPage, ProposalPricing, ProposalsQuery, Quote, QuoteSchema, Webhook,
} from './schemas.js';

/**
 * Description OpenAPI 3.1 de /api/v1, CONSTRUITE depuis les schémas Zod
 * (aucune description écrite à la main qui pourrait diverger du code).
 * La même table sert : au document servi (`/api/v1/openapi.json`), au
 * fichier `openapi.yaml` du dépôt, au client TypeScript généré, et au test
 * qui vérifie que chaque route du contrôleur y figure.
 */

export const API_VERSION = '1.0.0';

interface Operation {
  readonly method: 'get' | 'post' | 'delete';
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tag: string;
  readonly scope: ApiScope;
  readonly pathParams?: Record<string, { description: string; uuid?: boolean }>;
  readonly query?: z.ZodObject;
  readonly body?: string;
  readonly response: string;
  readonly etag?: boolean;
  readonly paginated?: boolean;
}

/** Schémas nommés : `#/components/schemas/<nom>`. */
const COMPONENTS: Record<string, z.ZodType> = {
  Contract, ContractPage, ContractDates, Deadline, DeadlinePage, Pricing, Quote, QuoteRequest: QuoteSchema,
  Webhook, CreateWebhookRequest: CreateWebhookBody, Problem, Proposal, ProposalPage, ProposalPricing,
};

export const OPERATIONS: readonly Operation[] = [
  {
    method: 'get', path: '/api/v1/clients/{clientRef}/contracts', operationId: 'listClientContracts', tag: 'Contrats',
    summary: 'Contrats d’un client', scope: 'contracts:read', etag: true, paginated: true,
    description: '`clientRef` : identifiant du client (UUID), son SIREN (9 chiffres) ou sa référence externe (Client Help).',
    pathParams: { clientRef: { description: 'UUID, SIREN ou référence externe du client' } },
    query: ClientContractsQuery, response: 'ContractPage',
  },
  {
    method: 'get', path: '/api/v1/contracts/{id}', operationId: 'getContract', tag: 'Contrats',
    summary: 'Détail d’un contrat : statut, origine, mode de signature', scope: 'contracts:read', etag: true,
    pathParams: { id: { description: 'Identifiant du contrat', uuid: true } }, response: 'Contract',
  },
  {
    method: 'get', path: '/api/v1/contracts/{id}/dates', operationId: 'getContractDates', tag: 'Contrats',
    summary: 'Dates clés : effet, fin de période, date limite de préavis, prochaine révision, prochain renouvellement',
    scope: 'contracts:dates:read', etag: true,
    pathParams: { id: { description: 'Identifiant du contrat', uuid: true } }, response: 'ContractDates',
  },
  {
    method: 'get', path: '/api/v1/contracts/{id}/pricing', operationId: 'getContractPricing', tag: 'Tarification',
    summary: 'Barème applicable à une date, trace de calcul optionnelle', scope: 'pricing:read', etag: true,
    pathParams: { id: { description: 'Identifiant du contrat', uuid: true } }, query: PricingAtQuery, response: 'Pricing',
  },
  {
    method: 'post', path: '/api/v1/pricing/quote', operationId: 'quote', tag: 'Tarification',
    summary: 'Prix pour un client, un article, une quantité et une date', scope: 'pricing:quote',
    body: 'QuoteRequest', response: 'Quote',
  },
  {
    method: 'get', path: '/api/v1/deadlines', operationId: 'listDeadlines', tag: 'Échéances',
    summary: 'Échéances à venir, tous contrats confondus', scope: 'contracts:dates:read', etag: true, paginated: true,
    query: DeadlinesQuery, response: 'DeadlinePage',
  },
  {
    method: 'get', path: '/api/v1/proposals', operationId: 'listProposals', tag: 'Propositions',
    summary: 'Propositions commerciales du tenant', scope: 'proposals:read', etag: true, paginated: true,
    query: ProposalsQuery, response: 'ProposalPage',
  },
  {
    method: 'get', path: '/api/v1/clients/{clientRef}/proposals', operationId: 'listClientProposals', tag: 'Propositions',
    summary: 'Propositions d’un client ou d’un prospect', scope: 'proposals:read', etag: true, paginated: true,
    pathParams: { clientRef: { description: 'UUID, SIREN ou référence externe du client' } },
    query: ProposalsQuery, response: 'ProposalPage',
  },
  {
    method: 'get', path: '/api/v1/proposals/{id}', operationId: 'getProposal', tag: 'Propositions',
    summary: 'Détail d’une proposition : statut, montants, dates, contrat généré', scope: 'proposals:read', etag: true,
    pathParams: { id: { description: 'Identifiant de la proposition', uuid: true } }, response: 'Proposal',
  },
  {
    method: 'get', path: '/api/v1/proposals/{id}/pricing', operationId: 'getProposalPricing', tag: 'Propositions',
    summary: 'Tarif : configuration acceptée (figée) ou tableau proposé', scope: 'proposals:pricing:read', etag: true,
    pathParams: { id: { description: 'Identifiant de la proposition', uuid: true } }, response: 'ProposalPricing',
  },
  {
    method: 'get', path: '/api/v1/webhooks', operationId: 'listWebhooks', tag: 'Webhooks',
    summary: 'Abonnements aux webhooks sortants du tenant', scope: 'webhooks:manage', etag: true, response: 'Webhook',
  },
  {
    method: 'post', path: '/api/v1/webhooks', operationId: 'createWebhook', tag: 'Webhooks',
    summary: 'Crée un abonnement ; le secret HMAC n’est renvoyé qu’une fois', scope: 'webhooks:manage',
    body: 'CreateWebhookRequest', response: 'Webhook',
  },
  {
    method: 'delete', path: '/api/v1/webhooks/{id}', operationId: 'disableWebhook', tag: 'Webhooks',
    summary: 'Désactive un abonnement', scope: 'webhooks:manage',
    pathParams: { id: { description: 'Identifiant de l’abonnement', uuid: true } }, response: 'Webhook',
  },
];

const ERRORS = {
  '400': 'Requête invalide', '401': 'Clé d’API absente ou invalide', '403': 'Scope insuffisant ou API désactivée',
  '404': 'Ressource introuvable (ou hors du tenant)', '429': 'Débit dépassé (`Retry-After`)',
} as const;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

function queryParams(q: z.ZodObject) {
  return Object.entries(q.shape).map(([name, s]) => {
    const schema = s as z.ZodType;
    const js = jsonSchema(schema, 'input');
    const optional = schema.safeParse(undefined).success;
    return {
      name, in: 'query', required: !optional,
      ...(typeof js.description === 'string' ? { description: js.description } : {}),
      schema: js,
    };
  });
}

export function buildOpenApi(serverUrl = 'https://contrats.lsi-maintenance.fr') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const parameters = [
      ...Object.entries(op.pathParams ?? {}).map(([name, p]) => ({
        name, in: 'path', required: true, description: p.description,
        schema: p.uuid ? { type: 'string', format: 'uuid' } : { type: 'string', maxLength: 100 },
      })),
      ...(op.query ? queryParams(op.query) : []),
      ...(op.etag ? [{ name: 'If-None-Match', in: 'header', required: false, description: 'ETag d’une réponse précédente → 304 si inchangée.', schema: { type: 'string' } }] : []),
    ];
    const responses: Record<string, unknown> = {
      [op.method === 'post' && op.operationId !== 'quote' ? '201' : '200']: {
        description: 'Succès',
        headers: {
          ...(op.etag ? { ETag: { schema: { type: 'string' } } } : {}),
          'RateLimit-Remaining': { schema: { type: 'integer' } },
        },
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.response}` } } },
      },
      ...(op.etag ? { '304': { description: 'Non modifié (If-None-Match)' } } : {}),
    };
    for (const [code, description] of Object.entries(ERRORS)) {
      responses[code] = { description, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
    }
    (paths[op.path] ??= {})[op.method] = {
      operationId: op.operationId,
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      tags: [op.tag],
      security: [{ apiKey: [op.scope] }],
      'x-required-scope': op.scope,
      parameters,
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.body}` } } } } } : {}),
      responses,
    };
  }
  const schemas: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(COMPONENTS)) schemas[name] = jsonSchema(s, name.endsWith('Request') ? 'input' : 'output');

  return {
    openapi: '3.1.0',
    info: {
      title: 'LSI-Maintenance — API Contrats',
      version: API_VERSION,
      description:
        'API de lecture des contrats clients pour les applications de la suite LSI-Maintenance. ' +
        'Authentification par clé d’API (`Authorization: Bearer ctr_…`), scopes fins, débit limité par client. ' +
        'Pagination par curseur (`nextCursor`), `ETag` / `If-None-Match`, erreurs RFC 9457. Guide : docs/contrats/07-api.md.',
    },
    servers: [{ url: serverUrl }],
    tags: [{ name: 'Contrats' }, { name: 'Tarification' }, { name: 'Échéances' }, { name: 'Propositions' }, { name: 'Webhooks' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http', scheme: 'bearer', bearerFormat: 'ctr_<prefix>_<secret>',
          description: `Clé créée par un administrateur (Paramètres → API). Scopes : ${API_SCOPES.join(', ')}.`,
        },
      },
      schemas,
    },
    paths,
  };
}
