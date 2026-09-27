import { PricingError, type QuantityObservation, type QuantityProvider } from '@lsi/pricing';

/**
 * Fournisseur de quantités de l'application (04-tarification.md §9, §17.4).
 *
 * Jeton d'injection : le service dépend du PORT (`QuantityProvider` du
 * moteur), jamais d'un adaptateur. En test, on le remplace par un
 * `FakeQuantityProvider` ; en production, par l'adaptateur réel le jour où il
 * existe (RMM de Client Help — branchement documenté, pas supposé).
 *
 * `contractRef` transmis par PricingService = l'IDENTIFIANT du contrat
 * (uuid) : stable, unique, sans ambiguïté entre tenants. Un adaptateur réel
 * en déduit le client Client Help (Customer.externalRef) par une lecture
 * scopée — jamais depuis une donnée fournie par l'appelant.
 */
export const QUANTITY_PROVIDER = Symbol('QUANTITY_PROVIDER');

/**
 * Défaut : quantités MANUELLES uniquement. Les lignes à quantité saisie
 * (FIXED) n'appellent jamais de fournisseur ; une ligne PROVIDER sans
 * connecteur branché est une erreur explicite (409 QUANTITY_UNAVAILABLE),
 * jamais un 0 implicite — un prix faux facturé est pire qu'un prix non
 * calculé.
 */
export class ManualQuantityProvider implements QuantityProvider {
  getQuantity(contractRef: string, articleCode: string, date: string): Promise<QuantityObservation> {
    return Promise.reject(
      new PricingError(
        'QUANTITY_UNAVAILABLE',
        `Aucun fournisseur de quantités n’est branché : la quantité de « ${articleCode} » doit être saisie sur la ligne (FIXED).`,
        { contractRef, articleCode, date },
      ),
    );
  }
}
