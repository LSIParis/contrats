import {
  DEFAULT_SIGNING_ORDER,
  type SigningOrderPolicy,
  type SubmitterCommand,
} from './e-signature-provider.port.js';

/**
 * Ordre de signature : de la POLITIQUE au plan concret. (brief §7)
 *
 * Pur et déterministe : la même liste de signataires et la même politique
 * donnent toujours le même plan. C'est ce qui permet de le tester sans
 * provider, et d'expliquer au support pourquoi M. Dupont a reçu son
 * invitation après Mme Martin.
 */

export interface SigningPlan {
  /**
   * Traduction pour le provider : `preserved` = invitations successives,
   * `random` = tout le monde invité d'emblée.
   */
  readonly order: 'preserved' | 'random';
  /** Signataires triés, `signingOrder` recalculé (0 = premier). */
  readonly submitters: readonly SubmitterCommand[];
}

/**
 * Politique effective d'une commande.
 *
 * Les appelants historiques passent `order` + un `signingOrder` par
 * signataire : on respecte alors CET ordre (AS_DEFINED) plutôt que de le
 * réécrire en silence. Sans rien de tout cela : défaut du brief, client
 * d'abord.
 */
export function resolveSigningPolicy(cmd: {
  readonly signingOrder?: SigningOrderPolicy;
  readonly order?: 'preserved' | 'random';
}): SigningOrderPolicy {
  if (cmd.signingOrder) return cmd.signingOrder;
  if (cmd.order === 'random') return 'PARALLEL';
  if (cmd.order === 'preserved') return 'AS_DEFINED';
  return DEFAULT_SIGNING_ORDER;
}

/**
 * Calcule le plan de signature.
 *
 * Au sein d'une même partie, l'ordre relatif saisi est CONSERVÉ, et deux
 * signataires de même rang restent un groupe parallèle (DocuSeal : « même
 * numéro d'ordre = groupe »). Seul l'enchaînement ENTRE parties dépend de
 * la politique.
 */
export function planSigningOrder(
  submitters: readonly SubmitterCommand[],
  policy: SigningOrderPolicy,
): SigningPlan {
  if (submitters.length === 0) throw new Error('Aucun signataire : rien à planifier');

  const byDefinedOrder = [...submitters].sort((a, b) => a.signingOrder - b.signingOrder);

  switch (policy) {
    case 'PARALLEL':
      return { order: 'random', submitters: byDefinedOrder.map((s) => ({ ...s, signingOrder: 0 })) };

    case 'AS_DEFINED':
      return { order: 'preserved', submitters: byDefinedOrder };

    case 'CLIENT_THEN_LSI':
    case 'LSI_THEN_CLIENT': {
      const first = policy === 'CLIENT_THEN_LSI' ? 'CLIENT' : 'LSI';
      const firstGroup = rank(byDefinedOrder.filter((s) => s.party === first), 0);
      const next = firstGroup.length === 0 ? 0 : Math.max(...firstGroup.map((s) => s.signingOrder)) + 1;
      const secondGroup = rank(byDefinedOrder.filter((s) => s.party !== first), next);
      return { order: 'preserved', submitters: [...firstGroup, ...secondGroup] };
    }
  }
}

/** Renumérote à partir de `offset` en conservant les ex-æquo (groupes). */
function rank(sorted: readonly SubmitterCommand[], offset: number): SubmitterCommand[] {
  const distinct = [...new Set(sorted.map((s) => s.signingOrder))];
  return sorted.map((s) => ({ ...s, signingOrder: offset + distinct.indexOf(s.signingOrder) }));
}
