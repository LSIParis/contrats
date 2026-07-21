import { Injectable } from '@nestjs/common';
import { appendAudit } from '@lsi/persistence';

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
      await appendAudit(e);
    } catch (err) {
      // L'action utilisateur est déjà commitée : on ne la casse pas.
      console.error('[audit] écriture échouée', err);
    }
  }
}
