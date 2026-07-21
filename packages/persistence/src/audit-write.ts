import { unsafeUnscopedClient } from './scoped-client.js';
import { uuidv7 } from './uuid.js';

/**
 * Écriture et vérification de la piste d'audit. (§6.9)
 *
 * L'append et le verify passent par des fonctions SECURITY DEFINER bornées
 * (`app_append_audit`, `app_verify_audit_chain`, migrations 14/15) qui portent
 * la chaîne de hash et le verrou de sérialisation par tenant. On les appelle
 * via `unsafeUnscopedClient` DEPUIS le module persistence — l'accès brut y est
 * légitime (§10.3) — pour exposer aux applis une API typée sans qu'elles
 * touchent au client non-scopé. La table `audit_logs` reste append-only et
 * cloisonnée par RLS ; ces fonctions sont possédées par le superuser (elles
 * contournent donc la RLS FORCE à l'INSERT/parcours), mais le tenant vient
 * toujours d'un scope résolu serveur, jamais d'une entrée client.
 *
 * Le nom de la fonction SQL reste un littéral (jamais d'interpolation) ; seuls
 * les paramètres sont liés via le tag `$queryRaw` (§13.3).
 */
export interface AuditAppendInput {
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly actorUserId: string | null;
  readonly actorKind: string;
  readonly actorIp: string | null;
  readonly actorUserAgent: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly after: unknown;
  readonly requestId: string | null;
  readonly occurredAt: Date;
}

/** Ajoute une entrée d'audit chaînée ; renvoie le hash calculé. */
export async function appendAudit(e: AuditAppendInput): Promise<string> {
  const rows = await unsafeUnscopedClient.$queryRaw<{ app_append_audit: string }[]>`
    SELECT app_append_audit(
      ${uuidv7()}::uuid, ${e.tenantId}::uuid, ${e.customerId}::uuid,
      ${e.actorUserId}::uuid, ${e.actorKind}::text, ${e.actorIp}::text, ${e.actorUserAgent}::text,
      ${e.action}::text, ${e.resourceType}::text, ${e.resourceId}::uuid,
      ${JSON.stringify(e.after ?? null)}::jsonb, ${e.requestId}::text, ${e.occurredAt}::timestamptz)`;
  const hash = rows[0]?.app_append_audit;
  if (hash == null) throw new Error("app_append_audit n'a pas renvoyé de hash");
  return hash;
}

/**
 * Vérifie l'intégrité de la chaîne d'un tenant : renvoie l'`id` de la première
 * entrée altérée, ou `null` si la chaîne est intègre.
 */
export async function verifyAuditChain(tenantId: string): Promise<string | null> {
  const rows = await unsafeUnscopedClient.$queryRaw<{ app_verify_audit_chain: string | null }[]>`
    SELECT app_verify_audit_chain(${tenantId}::uuid)`;
  return rows[0]?.app_verify_audit_chain ?? null;
}
