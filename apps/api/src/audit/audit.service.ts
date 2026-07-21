import { Injectable } from '@nestjs/common';
import { unsafeUnscopedClient, uuidv7 } from '@lsi/persistence';

export interface AuditEntry {
  tenantId: string;
  customerId: string | null;
  actorUserId: string | null;
  actorKind: 'INTERNAL' | 'CLIENT' | 'SYSTEM';
  actorIp: string | null;
  actorUserAgent: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  after: unknown;
  requestId: string | null;
  occurredAt: Date;
}

@Injectable()
export class AuditService {
  /** Best-effort : n'échoue jamais l'appelant. */
  async record(e: AuditEntry): Promise<void> {
    try {
      await unsafeUnscopedClient.$queryRaw`
        SELECT app_append_audit(
          ${uuidv7()}::uuid, ${e.tenantId}::uuid, ${e.customerId}::uuid,
          ${e.actorUserId}::uuid, ${e.actorKind}::text, ${e.actorIp}::text, ${e.actorUserAgent}::text,
          ${e.action}::text, ${e.resourceType}::text, ${e.resourceId}::uuid,
          ${JSON.stringify(e.after ?? null)}::jsonb, ${e.requestId}::text, ${e.occurredAt}::timestamptz)`;
    } catch (err) {
      // L'action utilisateur est déjà commitée : on ne la casse pas.
      console.error('[audit] écriture échouée', err);
    }
  }
}
