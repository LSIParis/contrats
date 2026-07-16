/**
 * @lsi/domain — le cœur métier.
 *
 * Ne dépend NI de Prisma, NI de HTTP, NI de DocuSeal. Testable en mémoire :
 * 50 tests en ~30 ms, sans démarrer PostgreSQL.
 *
 * Si un jour tester une règle métier exige un conteneur, c'est que la logique
 * a fui dans la persistance — et c'est le signal qu'il faut la ramener ici.
 */

export * from './contract/contract.types.js';
export * from './contract/state-machine.js';
export * from './reminder/planning.js';
