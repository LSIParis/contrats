/**
 * @lsi/pricing — le moteur de tarification.
 *
 * Fonctions PURES et DÉTERMINISTES sur des données simples. Ne dépend NI de
 * Prisma, NI de HTTP, NI de la base : la couche persistance charge un
 * instantané (barèmes, indices, dérogations, catalogue de règles), résout les
 * quantités (étape asynchrone séparée), puis appelle `priceAt` — synchrone.
 *
 * Même entrée → même sortie, au centime et à la ligne de trace près. C'est ce
 * qui permet de rejouer un prix facturé il y a trois ans et d'obtenir le même
 * résultat, avec la même justification.
 */

export * from './errors.js';
export * from './money.js';
export * from './formula/tokenizer.js';
export * from './formula/parser.js';
export * from './formula/evaluator.js';
export * from './formula/validate.js';
