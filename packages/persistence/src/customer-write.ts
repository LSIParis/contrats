import { unsafeUnscopedClient } from './scoped-client.js';
import { uuidv7 } from './uuid.js';

/** SIREN déjà utilisé dans le tenant (contrainte UNIQUE(tenant_id, siren)). */
export class CustomerSirenConflict extends Error {}

export interface NewCustomerInput {
  tenantId: string;
  name: string;
  legalName?: string | null;
  siren?: string | null;
  vatNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  notes?: string | null;
  creatorUserId: string;
  /** true pour un AM (auto-affecté), false pour un admin (all_customers). */
  grantAccess: boolean;
}

export async function createCustomer(c: NewCustomerInput): Promise<{ id: string }> {
  const id = uuidv7();
  try {
    await unsafeUnscopedClient.$queryRaw`
      SELECT app_create_customer(
        ${id}::uuid, ${c.tenantId}::uuid, ${c.name}, ${c.legalName ?? null},
        ${c.siren ?? null}, ${c.vatNumber ?? null}, ${c.addressLine1 ?? null},
        ${c.addressLine2 ?? null}, ${c.postalCode ?? null}, ${c.city ?? null},
        ${c.country ?? 'FR'}, ${c.notes ?? null},
        ${c.creatorUserId}::uuid, ${c.grantAccess})`;
    return { id };
  } catch (e: any) {
    // La violation d'unicité SIREN remonte comme code Postgres 23505 (via P2010).
    // Seul SIREN est unique ici (l'id est un uuidv7, pas de collision).
    const code = e?.meta?.code ?? '';
    if (code === '23505' || String(e?.message ?? '').includes('23505')) {
      throw new CustomerSirenConflict('SIREN déjà utilisé pour ce tenant');
    }
    throw e;
  }
}
