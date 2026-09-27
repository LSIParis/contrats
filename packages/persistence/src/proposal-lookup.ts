import type { Prisma } from '@prisma/client';
import { unsafeUnscopedClient } from './scoped-client.js';
import type { ScopeRef } from './lifecycle-lookup.js';

/**
 * Lot 9 — exceptions NOMMÉES et BORNÉES au cloisonnement, pour les
 * propositions commerciales (migration 31). Même patron que
 * `lifecycle-lookup.ts` : fonctions SECURITY DEFINER qui ne renvoient que des
 * identifiants ; tout traitement se fait ENSUITE dans le scope résolu, sous RLS.
 */

export interface ResolvedProposalLink {
  readonly linkId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly proposalId: string;
  readonly versionId: string;
  readonly recipientId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Page publique : SHA-256 du jeton → identifiants du lien. Le jeton lui-même
 * n'arrive jamais en base. Renvoie aussi un lien révoqué ou expiré : c'est à
 * l'appelant de refuser (la page affiche alors un message dédié).
 */
export async function resolveProposalLink(tokenHash: string): Promise<ResolvedProposalLink | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const rows = await unsafeUnscopedClient.$queryRaw<
    {
      link_id: string; tenant_id: string; customer_id: string; proposal_id: string; version_id: string;
      recipient_id: string; expires_at: Date; revoked_at: Date | null;
    }[]
  >`SELECT * FROM app_resolve_proposal_link(${tokenHash}::text)`;
  const r = rows[0];
  if (!r) return null;
  return {
    linkId: r.link_id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    proposalId: r.proposal_id,
    versionId: r.version_id,
    recipientId: r.recipient_id,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

type Row = { id: string; tenant_id: string; customer_id: string };
const toRef = (r: Row): ScopeRef => ({ id: r.id, tenantId: r.tenant_id, customerId: r.customer_id });

/** Envoyées / consultées / en discussion dont l'échéance est passée. */
export async function findProposalsToExpire(limit = 500): Promise<ScopeRef[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<Row[]>`SELECT * FROM app_find_proposals_to_expire(${limit}::int)`;
  return rows.map(toRef);
}

/** Relances planifiées arrivées à échéance (`id` = la relance). */
export async function findProposalFollowUpsDue(limit = 500): Promise<ScopeRef[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<Row[]>`SELECT * FROM app_find_proposal_follow_ups_due(${limit}::int)`;
  return rows.map(toRef);
}

/** Signées sans contrat généré : filet de la conversion (job perdu). */
export async function findProposalsToConvert(limit = 100): Promise<ScopeRef[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<Row[]>`SELECT * FROM app_find_proposals_to_convert(${limit}::int)`;
  return rows.map(toRef);
}

/** Soumissions DocuSeal de propositions sans nouvelle récente (webhook perdu). */
export async function findProposalSignaturesNeedingSync(
  staleMinutes = 60,
  limit = 200,
): Promise<(ScopeRef & { providerSubmissionId: string })[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<(Row & { provider_submission_id: string })[]>`
    SELECT * FROM app_find_proposal_signatures_needing_sync(${staleMinutes}::int, ${limit}::int)`;
  return rows.map((r) => ({ ...toRef(r), providerSubmissionId: r.provider_submission_id }));
}

/** Soumissions complétées dont les preuves restent à rapatrier (la proposition passe SIGNÉE après). */
export async function findProposalSignaturesNeedingProof(
  limit = 100,
): Promise<(ScopeRef & { proposalId: string })[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<(Row & { proposal_id: string })[]>`
    SELECT * FROM app_find_proposal_signatures_needing_proof(${limit}::int)`;
  return rows.map((r) => ({ ...toRef(r), proposalId: r.proposal_id }));
}

/** Tenants ayant du suivi de lecture détaillé (purge RGPD). */
export async function findProposalTrackingTenants(): Promise<string[]> {
  const rows = await unsafeUnscopedClient.$queryRaw<{ tenant_id: string }[]>`
    SELECT * FROM app_find_proposal_tracking_tenants()`;
  return rows.map((r) => r.tenant_id);
}

/**
 * Purge du suivi détaillé d'un tenant, DANS la transaction scopée de ce
 * tenant (`tx` de withScope) : la fonction refuse tout autre tenant.
 */
export async function purgeProposalViewEvents(
  tx: Prisma.TransactionClient,
  tenantId: string,
  retentionDays: number,
): Promise<number> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT app_purge_proposal_view_events(${tenantId}::uuid, ${retentionDays}::int) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Numéro suivant PROP-AAAA-NNNN : incrément ATOMIQUE du compteur du tenant
 * (INSERT … ON CONFLICT DO UPDATE … RETURNING), dans la transaction scopée.
 * Deux créations concurrentes obtiennent deux numéros distincts, sans reprise.
 */
export async function nextProposalSequence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  year: number,
): Promise<number> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO proposal_sequences (tenant_id, year, last_value)
    VALUES (${tenantId}::uuid, ${year}::int, 1)
    ON CONFLICT (tenant_id, year) DO UPDATE SET last_value = proposal_sequences.last_value + 1
    RETURNING last_value`;
  const v = rows[0]?.last_value;
  if (v == null) throw new Error('compteur de propositions indisponible');
  return Number(v);
}
