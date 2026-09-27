/**
 * Point d'extension « paiement d'acompte à la signature » (brief §12.10) —
 * HORS PÉRIMÈTRE V1 : interface seule, AUCUNE implémentation.
 *
 * Emplacement prévu dans le parcours (11-propositions.md §9) : après
 * l'acceptation et la signature de la proposition, AVANT la conversion en
 * contrat, si le modèle de proposition exige un acompte. Tant que le choix du
 * prestataire (Stripe, GoCardless…) n'est pas fait, aucune donnée ne part
 * vers un tiers : c'est la souveraineté des données qui décide ici, pas la
 * commodité.
 */
export interface DepositRequest {
  /** Identifiant de la proposition signée (jamais une donnée de carte). */
  readonly proposalId: string;
  readonly amountCents: number;
  readonly currency: 'EUR';
  /** Adresse de retour construite côté serveur (jamais depuis une entrée utilisateur). */
  readonly returnUrl: string;
}

export interface DepositSession {
  readonly providerReference: string;
  /** Page de paiement hébergée par le prestataire. */
  readonly redirectUrl: string;
}

export type DepositStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';

export interface PaymentProvider {
  readonly name: string;
  createDepositSession(req: DepositRequest): Promise<DepositSession>;
  getDepositStatus(providerReference: string): Promise<DepositStatus>;
}
