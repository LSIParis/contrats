import { PrismaClient } from '@prisma/client';

/**
 * Résolution du scope d'un webhook. (§11.4)
 *
 * LA SECONDE et dernière exception au cloisonnement, avec la découverte des
 * rappels par le scheduler (§12.3).
 *
 * Elle vit ICI, dans persistence, et non dans l'API : ce module possède les
 * exceptions au cloisonnement. Les disperser dans les services applicatifs,
 * ce serait les rendre invisibles — et une exception invisible n'est plus une
 * exception, c'est un trou.
 *
 * Le rôle `lsi_webhook` ne peut lire que six colonnes d'identité de
 * signature_requests. Il ne peut rien écrire, et ne voit ni le PDF signé, ni
 * les hashes, ni les messages d'erreur.
 *
 * Le traitement de l'événement se fait ENSUITE sous `lsi_app`, dans le scope
 * résolu, via withScope().
 */

let client: PrismaClient | null = null;

function webhookClient(): PrismaClient {
  if (!client) {
    const url = process.env.DATABASE_URL_WEBHOOK ?? buildWebhookUrl();
    client = new PrismaClient({ datasourceUrl: url });
  }
  return client;
}

/**
 * Dérive l'URL du rôle webhook depuis celle de l'application.
 *
 * En production, DATABASE_URL_WEBHOOK est fournie explicitement par Secrets
 * Manager. Cette dérivation sert au développement et aux tests.
 */
function buildWebhookUrl(): string {
  const base = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Aucune URL de base de données pour le rôle webhook');
  const u = new URL(base);
  u.username = 'lsi_webhook';
  u.password = process.env.DB_WEBHOOK_PASSWORD ?? 'lsi_webhook_test_pwd';
  return u.toString();
}

export interface ResolvedWebhookScope {
  readonly signatureRequestId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly contractId: string;
}

/**
 * Trouve le scope d'une submission provider.
 *
 * S'appuie sur UNIQUE (provider, provider_submission_id) : la correspondance
 * est déterministe vers le couple (tenant, customer) que NOUS avons écrit à
 * la création de la demande.
 *
 * C'est ce qui rend inoffensif un payload forgé : un attaquant qui
 * prétendrait un autre tenant n'obtiendrait rien, puisque le scope ne vient
 * jamais de ce qu'il envoie.
 */
export async function resolveWebhookScope(
  provider: 'DOCUSEAL',
  providerSubmissionId: string,
): Promise<ResolvedWebhookScope | null> {
  const rows = await webhookClient().$queryRaw<
    { id: string; tenant_id: string; customer_id: string; contract_id: string }[]
  >`
    SELECT id, tenant_id, customer_id, contract_id
    FROM signature_requests
    WHERE provider = ${provider}::"SignatureProvider"
      AND provider_submission_id = ${providerSubmissionId}
    LIMIT 1
  `;

  const r = rows[0];
  if (!r) return null;
  return {
    signatureRequestId: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    contractId: r.contract_id,
  };
}
