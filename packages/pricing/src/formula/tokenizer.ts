import { FormulaError } from '../errors.js';

/**
 * Analyse lexicale des formules tarifaires. (brief §5 « moteur sans eval »)
 *
 * Écrite à la main, caractère par caractère. Aucune expression régulière
 * globale, aucun `eval`, aucun `new Function` : la formule n'est JAMAIS du
 * code JavaScript, seulement une suite de jetons que l'analyseur accepte ou
 * refuse. Tout caractère hors de l'alphabet ci-dessous est une erreur, avec
 * sa position — l'éditeur de formule peut la souligner.
 *
 * Alphabet :
 *   nombre      : chiffres, éventuellement « . » suivi de chiffres (1, 0.85)
 *                 — pas d'exposant, pas de « .5 », pas de « 1. », pas de
 *                 virgule décimale (la virgule sépare les arguments).
 *   identifiant : lettre ou « _ », puis lettres, chiffres, « _ » (P0, S1, qty)
 *   opérateurs  : + - * / ^ < <= > >= == !=
 *   ponctuation : ( ) ,
 *   blancs      : espace, tabulation, retour à la ligne (ignorés)
 */

export type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** Index (base 0) du premier caractère du jeton dans la formule. */
  readonly pos: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isBlank = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

const TWO_CHAR_OPS = new Set(['<=', '>=', '==', '!=']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '<', '>']);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (i < src.length && isDigit(src.charAt(i))) i++;
      if (src.charAt(i) === '.') {
        i++;
        if (!isDigit(src.charAt(i))) {
          throw new FormulaError('FORMULA_SYNTAX', `Nombre incomplet à la position ${start} : un chiffre est attendu après le point.`, start);
        }
        while (i < src.length && isDigit(src.charAt(i))) i++;
      }
      tokens.push({ type: 'number', value: src.slice(start, i), pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src.charAt(i))) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      tokens.push({ type: 'op', value: c, pos: i });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ type: c === '(' ? 'lparen' : c === ')' ? 'rparen' : 'comma', value: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError('FORMULA_SYNTAX', `Caractère « ${c} » non autorisé à la position ${i}.`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}
