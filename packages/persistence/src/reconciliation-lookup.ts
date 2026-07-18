import { unsafeUnscopedClient } from './scoped-client.js';

/**
 * Découverte des signatures dont la preuve reste à capturer. (EC-06)
 *
 * Lecture hors scope volontaire — comme la découverte des rappels, on cherche
 * DE QUEL scope relève chaque tâche. Via la fonction SECURITY DEFINER bornée :
 * ne renvoie que des identifiants, aucun contenu.
 */
export async function findSignaturesNeedingProof(
  limit = 200,
): Promise<{ id: string; tenantId: string; customerId: string }[]> {
  // ::int car Prisma passe un number JS en bigint, et la fonction attend int.
  const rows = await unsafeUnscopedClient.$queryRaw<
    { id: string; tenant_id: string; customer_id: string }[]
  >`SELECT * FROM app_find_signatures_needing_proof(${limit}::int)`;
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, customerId: r.customer_id }));
}
