import { PrismaClient, type Prisma } from '@prisma/client';
import type { Scope } from './scope.js';

/**
 * Le client Prisma applicatif. Se connecte avec le rôle `lsi_app` :
 * NON-propriétaire des tables, SANS BYPASSRLS (§10.3).
 *
 * Cet export est réservé au module persistence. Toute utilisation
 * ailleurs est interdite par ESLint no-restricted-imports (§16.4-D) :
 * une requête émise hors de withScope() lève une exception PostgreSQL.
 */
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL,
});

function toPgUuidArray(ids: readonly string[]): string {
  // Les valeurs proviennent de la session serveur, jamais d'une entrée
  // utilisateur. On valide malgré tout : defense in depth.
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Scope invalide : "${id}" n'est pas un UUID`);
    }
  }
  return `{${ids.join(',')}}`;
}

/**
 * LE seul chemin d'accès aux données. (§10.3)
 *
 * Positionne les GUC de scope pour la durée de la transaction, puis
 * exécute `fn`. RLS s'appuie sur ces GUC.
 *
 * `set_config(..., true)` → portée TRANSACTION. C'est ce troisième
 * argument qui empêche le scope de survivre au commit et de polluer la
 * requête d'un autre utilisateur sur une connexion recyclée du pool.
 * Sans lui : fuite inter-client silencieuse et intermittente (R12).
 */
export async function withScope<T>(
  scope: Scope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.customer_ids', ${toPgUuidArray(scope.customerIds)}, true)`;
    await tx.$executeRaw`SELECT set_config('app.all_customers', ${scope.allCustomers ? 'on' : 'off'}, true)`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.actor_kind', ${scope.actorKind}, true)`;
    return fn(tx);
  });
}

export { prisma as unsafeUnscopedClient };
