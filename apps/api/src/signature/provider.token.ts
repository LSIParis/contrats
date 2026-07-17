/**
 * Jeton d'injection du port de signature.
 *
 * Le service dépend de l'INTERFACE, pas de DocusealAdapter. C'est ce qui
 * rend le remplacement de provider possible sans toucher au métier (§11.1)
 * — et ce qui permet de tester la logique d'envoi sans DocuSeal.
 */
export const ESIGNATURE_PROVIDER = Symbol('ESIGNATURE_PROVIDER');
