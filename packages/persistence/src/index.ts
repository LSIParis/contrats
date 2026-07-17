/**
 * @lsi/persistence — le SEUL chemin d'accès aux données.
 *
 * `withScope()` est la seule façon d'émettre une requête. Le client Prisma
 * brut n'est pas exporté sous un nom utilisable par mégarde, et ESLint
 * interdit son import hors de ce module (§16.4-D).
 *
 * Une requête émise hors de withScope() lève une exception PostgreSQL :
 * elle ne renvoie pas « zéro ligne ». C'est la garantie centrale (§10.3).
 */

export { withScope, unsafeUnscopedClient } from './scoped-client.js';
export {
  internalScope,
  adminScope,
  clientScope,
  systemScope,
  type Scope,
  type ActorKind,
} from './scope.js';
export { uuidv7 } from './uuid.js';
export {
  resolveWebhookScope,
  type ResolvedWebhookScope,
} from './webhook-scope-lookup.js';
