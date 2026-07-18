import { PrismaClient } from '@prisma/client';

/**
 * Découverte des rappels dus. (§12.3)
 *
 * L'UNE des deux seules requêtes hors scope de l'application (avec la
 * résolution du webhook). Elle balaie tous les tenants pour trouver le travail
 * à faire — mais sous le rôle `lsi_scheduler`, borné en lecture à CINQ colonnes
 * d'identité de la seule table reminders (id, tenant_id, customer_id, status,
 * due_at). Il ne voit ni contrat, ni email, ni montant.
 *
 * Le traitement de chaque rappel se fait ENSUITE sous `lsi_app`, dans le scope
 * résolu, via withScope().
 */

let client: PrismaClient | null = null;

function schedulerClient(): PrismaClient {
  if (!client) {
    const url = process.env.DATABASE_URL_SCHEDULER ?? buildSchedulerUrl();
    client = new PrismaClient({ datasourceUrl: url });
  }
  return client;
}

function buildSchedulerUrl(): string {
  const base = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Aucune URL de base de données pour le rôle scheduler');
  const u = new URL(base);
  u.username = 'lsi_scheduler';
  u.password = process.env.DB_SCHEDULER_PASSWORD ?? 'lsi_scheduler_test_pwd';
  return u.toString();
}

export interface DueReminderRef {
  readonly id: string;
  readonly tenantId: string;
  readonly customerId: string;
}

/**
 * Les rappels PENDING dont l'échéance est atteinte.
 *
 * Requête volontairement identique à celle qu'un test fige comme « la seule
 * raison d'être » du rôle scheduler.
 */
export async function findDueReminders(limit = 500): Promise<DueReminderRef[]> {
  const rows = await schedulerClient().$queryRaw<
    { id: string; tenant_id: string; customer_id: string }[]
  >`
    SELECT id, tenant_id, customer_id
    FROM reminders
    WHERE status = 'PENDING' AND due_at <= now()
    ORDER BY due_at
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, customerId: r.customer_id }));
}
