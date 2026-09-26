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
export * from './signature/e-signature-provider.port.js';
export * from './signature/signing-order.js';
export * from './signature/text-tags.js';
export * from './signature/document-hash.js';
export * from './documents/document-renderer.port.js';
export * from './notifications/email-sender.port.js';
export * from './pseudonymization/pseudonymize.js';
export * from './import-extraction/extract-metadata.js';
