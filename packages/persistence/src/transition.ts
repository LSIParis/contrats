import type { Prisma } from '@prisma/client';

/**
 * Contexte d'une transition d'état, lu par le trigger
 * `contracts_status_transition` (migration 17).
 *
 * Le trigger enregistre TOUTE transition (from → to, acteur, horodatage) sans
 * rien demander au code applicatif — c'est ce qui garantit qu'aucune ne lui
 * échappe. Ce qu'il ne peut pas deviner, c'est le POURQUOI : l'événement
 * métier (SUBMIT_FOR_REVIEW, ACCEPT…) et le motif saisi. Le service les pose
 * ici, dans la même transaction, AVANT l'UPDATE du statut.
 *
 * `set_config(..., true)` : portée transaction, comme les GUC de scope — le
 * motif d'une transition ne survit pas au commit et ne peut pas « déteindre »
 * sur la requête suivante servie par la même connexion du pool.
 */
export async function setTransitionContext(
  tx: Prisma.TransactionClient,
  ctx: { readonly event: string; readonly reason?: string | null },
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.transition_event', ${ctx.event}, true)`;
  await tx.$executeRaw`SELECT set_config('app.transition_reason', ${ctx.reason ?? ''}, true)`;
}
