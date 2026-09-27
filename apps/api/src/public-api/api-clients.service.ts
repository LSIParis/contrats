import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { adminScope, resolveApiKeyPrefix, withScope, uuidv7, type Scope } from '@lsi/persistence';
import { API_SCOPES, generateApiKey, hashMatches, parseApiKey } from './api-key.js';

export const CreateApiClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
    rateLimitPerMinute: z.number().int().min(1).max(10_000).default(120),
  })
  .strict();
export type CreateApiClient = z.infer<typeof CreateApiClientSchema>;

export interface AuthenticatedClient {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
}

const PUBLIC_FIELDS = {
  id: true, name: true, description: true, keyPrefix: true, scopes: true, rateLimitPerMinute: true,
  active: true, revokedAt: true, lastUsedAt: true, createdAt: true, updatedAt: true,
} as const;

/**
 * Clients de l'API publique : administration (MSP_ADMIN), authentification
 * d'une clé, journal des appels. La clé en clair n'existe qu'en mémoire, le
 * temps de la renvoyer UNE fois à l'administrateur.
 */
@Injectable()
export class ApiClientsService {
  private readonly log = new Logger(ApiClientsService.name);

  list(scope: Scope) {
    return withScope(scope, (tx) => tx.apiClient.findMany({ select: PUBLIC_FIELDS, orderBy: { createdAt: 'asc' } }));
  }

  async create(scope: Scope, input: CreateApiClient, now: Date) {
    const k = generateApiKey();
    const row = await withScope(scope, (tx) => tx.apiClient.create({
      data: {
        id: uuidv7(), tenantId: scope.tenantId, name: input.name, description: input.description ?? null,
        keyPrefix: k.prefix, keyHash: k.hash, scopes: [...new Set(input.scopes)], rateLimitPerMinute: input.rateLimitPerMinute,
        createdByUserId: scope.userId, createdAt: now, updatedAt: now,
      },
      select: PUBLIC_FIELDS,
    }));
    return { ...row, apiKey: k.key };
  }

  /** Nouvelle clé ; l'ancienne cesse de fonctionner immédiatement. */
  async rotate(scope: Scope, id: string, now: Date) {
    const k = generateApiKey();
    const row = await withScope(scope, async (tx) => {
      const found = await tx.apiClient.findUnique({ where: { id } });
      if (!found || !found.active) throw new NotFoundException('Client d’API introuvable ou révoqué');
      return tx.apiClient.update({ where: { id }, data: { keyPrefix: k.prefix, keyHash: k.hash, updatedAt: now }, select: PUBLIC_FIELDS });
    });
    return { ...row, apiKey: k.key };
  }

  async revoke(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      const found = await tx.apiClient.findUnique({ where: { id } });
      if (!found) throw new NotFoundException('Client d’API introuvable');
      if (!found.active) return tx.apiClient.findUnique({ where: { id }, select: PUBLIC_FIELDS });
      return tx.apiClient.update({ where: { id }, data: { active: false, revokedAt: now, updatedAt: now }, select: PUBLIC_FIELDS });
    });
  }

  /** Clé présentée → client authentifié, ou null (quelle qu'en soit la raison). */
  async authenticate(key: string): Promise<AuthenticatedClient | null> {
    const parsed = parseApiKey(key);
    if (!parsed) return null;
    const row = await resolveApiKeyPrefix(parsed.prefix);
    if (!row || !hashMatches(parsed.secret, row.keyHash)) return null;
    return { id: row.id, tenantId: row.tenantId, scopes: row.scopes, rateLimitPerMinute: row.rateLimitPerMinute };
  }

  /** Journal d'un appel (best-effort : n'échoue jamais la requête). */
  async record(client: AuthenticatedClient, call: { method: string; route: string; status: number; durationMs: number; requestId: string }, now: Date) {
    try {
      await withScope(adminScope(client.tenantId, client.id), async (tx) => {
        await tx.apiCallLog.create({
          data: {
            id: uuidv7(), tenantId: client.tenantId, clientId: client.id, method: call.method.slice(0, 10),
            route: call.route.slice(0, 200), status: call.status, durationMs: Math.max(0, Math.round(call.durationMs)),
            requestId: call.requestId.slice(0, 100), createdAt: now,
          },
        });
        await tx.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
      });
    } catch (e) {
      this.log.error(`journal d'appel API non écrit : ${(e as Error).message}`);
    }
  }
}
