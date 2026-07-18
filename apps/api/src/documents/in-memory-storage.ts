import { Injectable, Logger } from '@nestjs/common';
import { assertKeyMatchesScope, type DocumentStorage, type ObjectScope } from './document-storage.port.js';

/**
 * Stockage en mémoire — développement et tests.
 *
 * Simule le refus de lecture inter-scope (ce que KMS ferait en AWS) : un get
 * avec un contexte différent de celui du put échoue. Ne persiste rien.
 */
@Injectable()
export class InMemoryStorage implements DocumentStorage {
  private readonly log = new Logger(InMemoryStorage.name);
  private readonly objects = new Map<string, { data: Buffer; scope: ObjectScope }>();

  async put(key: string, data: Buffer, scope: ObjectScope): Promise<void> {
    assertKeyMatchesScope(key, scope);
    this.objects.set(key, { data, scope });
  }

  async get(key: string, scope: ObjectScope): Promise<Buffer | null> {
    assertKeyMatchesScope(key, scope);
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.scope.tenantId !== scope.tenantId || o.scope.customerId !== scope.customerId) {
      this.log.error(`ALERTE : lecture de ${key} avec un contexte étranger`);
      throw new Error('AccessDenied: encryption context mismatch');
    }
    return o.data;
  }

  async presignedGetUrl(key: string, scope: ObjectScope): Promise<string> {
    assertKeyMatchesScope(key, scope);
    return `memory://${key}`;
  }
}
