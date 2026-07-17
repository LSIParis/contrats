import { Injectable, Logger } from '@nestjs/common';

export interface ObjectScope {
  readonly tenantId: string;
  readonly customerId: string;
}

/**
 * Stockage documentaire. (§10.7)
 *
 * En production : S3 eu-west-3, SSE-KMS avec un ENCRYPTION CONTEXT
 * {tenant_id, customer_id}.
 *
 * L'encryption context est le point clé, et il vaut d'être expliqué : il est
 * authentifié cryptographiquement (données additionnelles de l'AES-GCM). Un
 * objet chiffré avec customer_id = A ne PEUT PAS être déchiffré en présentant
 * customer_id = B — KMS refuse, mathématiquement, pas par politique.
 *
 * Conséquence : même si un bug applicatif construisait la mauvaise clé S3 et
 * parvenait à lire l'octet chiffré d'un autre client, le déchiffrement
 * échouerait. C'est une garantie qui SURVIT à une erreur de code — ce qu'une
 * simple convention de préfixe ne fait pas.
 *
 * Et cela évite 100 CMK à 1 $/mois : une clé par tenant, l'isolation par
 * client venant du contexte.
 *
 * Implémentation actuelle : en mémoire. L'adaptateur S3 est le ticket W-06,
 * et il devra être testé contre MinIO — l'encryption context ne se vérifie
 * pas dans une Map.
 */
@Injectable()
export class ObjectStorage {
  private readonly log = new Logger(ObjectStorage.name);
  private readonly objects = new Map<string, { data: Buffer; scope: ObjectScope }>();

  async put(key: string, data: Buffer, scope: ObjectScope): Promise<void> {
    this.assertKeyMatchesScope(key, scope);
    this.objects.set(key, { data, scope });
  }

  async get(key: string, scope: ObjectScope): Promise<Buffer | null> {
    this.assertKeyMatchesScope(key, scope);
    const o = this.objects.get(key);
    if (!o) return null;

    // Simule le refus de KMS : le contexte de déchiffrement doit correspondre
    // à celui du chiffrement. En production c'est KMS qui refuse, pas nous.
    if (o.scope.tenantId !== scope.tenantId || o.scope.customerId !== scope.customerId) {
      this.log.error(`ALERTE : lecture de ${key} avec un contexte étranger`);
      throw new Error('AccessDenied: encryption context mismatch');
    }
    return o.data;
  }

  /**
   * La clé DOIT porter le scope qu'elle prétend.
   *
   * Attrape en développement le bug que KMS attraperait en production —
   * mais plus tôt, et avec un message utile.
   */
  private assertKeyMatchesScope(key: string, scope: ObjectScope): void {
    const expected = `t/${scope.tenantId}/c/${scope.customerId}/`;
    if (!key.startsWith(expected)) {
      throw new Error(`Clé ${key} incohérente avec le scope ${expected}`);
    }
  }
}
