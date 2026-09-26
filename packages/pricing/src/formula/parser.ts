import { FormulaError } from '../errors.js';
import { tokenize, type Token } from './tokenizer.js';

/**
 * Analyseur syntaxique par descente récursive → arbre syntaxique (AST).
 *
 * Grammaire (EBNF, reprise dans docs/contrats/04-tarification.md) :
 *
 *   formule     = comparaison , EOF ;
 *   comparaison = additif , [ ( "<" | "<=" | ">" | ">=" | "==" | "!=" ) , additif ] ;
 *   additif     = terme , { ( "+" | "-" ) , terme } ;
 *   terme       = unaire , { ( "*" | "/" ) , unaire } ;
 *   unaire      = ( "-" | "+" ) , unaire | puissance ;
 *   puissance   = primaire , [ "^" , unaire ] ;          (associatif à droite)
 *   primaire    = nombre | appel | identifiant | "(" , comparaison , ")" ;
 *   appel       = identifiant , "(" , [ comparaison , { "," , comparaison } ] , ")" ;
 *
 * Conséquences voulues :
 *   - `-2 ^ 2` vaut -4 (comme en mathématiques, et comme dans un tableur
 *     sérieux — pas comme dans Excel, qui donne 4) ;
 *   - `2 ^ 3 ^ 2` vaut 2^9 = 512 ;
 *   - `1 < 2 < 3` est REFUSÉ (comparaison non associative) : l'écriture est
 *     presque toujours une erreur de logique, on ne lui donne pas de sens.
 *
 * Gardes : longueur maximale du texte et profondeur maximale d'imbrication.
 * Une formule est saisie par un humain dans un barème ; au-delà de ces bornes,
 * c'est une erreur ou une tentative d'épuiser la pile — refusée dans les deux cas.
 *
 * L'analyseur NE vérifie PAS les noms de variables ni de fonctions : c'est le
 * rôle de validateFormula (qui collecte toutes les erreurs) et de l'évaluateur
 * (qui refuse à l'exécution). Séparer les deux permet d'afficher l'arbre d'une
 * formule même si une variable n'est pas encore déclarée.
 */

export const FORMULA_MAX_LENGTH = 1000;
export const FORMULA_MAX_DEPTH = 32;

export type ComparisonOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type BinaryOp = '+' | '-' | '*' | '/' | '^' | ComparisonOp;

export type FormulaNode =
  | { readonly type: 'number'; readonly value: string; readonly pos: number }
  | { readonly type: 'variable'; readonly name: string; readonly pos: number }
  | { readonly type: 'unary'; readonly op: '-' | '+'; readonly operand: FormulaNode; readonly pos: number }
  | {
      readonly type: 'binary';
      readonly op: BinaryOp;
      readonly left: FormulaNode;
      readonly right: FormulaNode;
      readonly pos: number;
    }
  | { readonly type: 'call'; readonly name: string; readonly args: readonly FormulaNode[]; readonly pos: number };

export interface ParsedFormula {
  readonly source: string;
  readonly ast: FormulaNode;
  /** Variables référencées, triées, sans doublon. */
  readonly variables: readonly string[];
  /** Fonctions appelées, triées, sans doublon. */
  readonly functions: readonly string[];
}

const COMPARISON_OPS = new Set<string>(['<', '<=', '>', '>=', '==', '!=']);

class Parser {
  private i = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    // Le dernier jeton est toujours EOF : l'index ne dépasse jamais la fin.
    return this.tokens[Math.min(this.i, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private unexpected(t: Token, expected: string): never {
    const what = t.type === 'eof' ? 'la fin de la formule' : `« ${t.value} »`;
    throw new FormulaError('FORMULA_SYNTAX', `${expected} attendu, ${what} trouvé à la position ${t.pos}.`, t.pos);
  }

  private enter(pos: number): void {
    if (++this.depth > FORMULA_MAX_DEPTH) {
      throw new FormulaError(
        'FORMULA_LIMIT',
        `Formule trop imbriquée (profondeur maximale ${FORMULA_MAX_DEPTH}) à la position ${pos}.`,
        pos,
      );
    }
  }

  private leave(): void {
    this.depth--;
  }

  parseFormula(): FormulaNode {
    const node = this.parseComparison();
    const t = this.peek();
    if (t.type !== 'eof') {
      if (t.type === 'op' && COMPARISON_OPS.has(t.value)) {
        throw new FormulaError(
          'FORMULA_SYNTAX',
          `Comparaisons chaînées interdites (position ${t.pos}) : utiliser if() ou des parenthèses.`,
          t.pos,
        );
      }
      this.unexpected(t, 'Opérateur ou fin de formule');
    }
    return node;
  }

  private parseComparison(): FormulaNode {
    this.enter(this.peek().pos);
    let node = this.parseAdditive();
    const t = this.peek();
    if (t.type === 'op' && COMPARISON_OPS.has(t.value)) {
      this.next();
      const right = this.parseAdditive();
      node = { type: 'binary', op: t.value as ComparisonOp, left: node, right, pos: t.pos };
    }
    this.leave();
    return node;
  }

  private parseAdditive(): FormulaNode {
    let node = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || (t.value !== '+' && t.value !== '-')) return node;
      this.next();
      node = { type: 'binary', op: t.value, left: node, right: this.parseTerm(), pos: t.pos };
    }
  }

  private parseTerm(): FormulaNode {
    let node = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || (t.value !== '*' && t.value !== '/')) return node;
      this.next();
      node = { type: 'binary', op: t.value, left: node, right: this.parseUnary(), pos: t.pos };
    }
  }

  private parseUnary(): FormulaNode {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      this.enter(t.pos);
      const operand = this.parseUnary();
      this.leave();
      return { type: 'unary', op: t.value, operand, pos: t.pos };
    }
    return this.parsePower();
  }

  private parsePower(): FormulaNode {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t.type === 'op' && t.value === '^') {
      this.next();
      this.enter(t.pos);
      const exponent = this.parseUnary();
      this.leave();
      return { type: 'binary', op: '^', left: base, right: exponent, pos: t.pos };
    }
    return base;
  }

  private parsePrimary(): FormulaNode {
    const t = this.next();
    if (t.type === 'number') return { type: 'number', value: t.value, pos: t.pos };
    if (t.type === 'lparen') {
      const inner = this.parseComparison();
      const close = this.next();
      if (close.type !== 'rparen') this.unexpected(close, '« ) »');
      return inner;
    }
    if (t.type === 'ident') {
      if (this.peek().type !== 'lparen') return { type: 'variable', name: t.value, pos: t.pos };
      this.next(); // (
      const args: FormulaNode[] = [];
      if (this.peek().type === 'rparen') {
        this.next();
      } else {
        for (;;) {
          args.push(this.parseComparison());
          const sep = this.next();
          if (sep.type === 'rparen') break;
          if (sep.type !== 'comma') this.unexpected(sep, '« , » ou « ) »');
        }
      }
      return { type: 'call', name: t.value, args, pos: t.pos };
    }
    return this.unexpected(t, 'Nombre, variable, fonction ou « ( »');
  }
}

function collect(node: FormulaNode, vars: Set<string>, fns: Set<string>): void {
  switch (node.type) {
    case 'number':
      return;
    case 'variable':
      vars.add(node.name);
      return;
    case 'unary':
      collect(node.operand, vars, fns);
      return;
    case 'binary':
      collect(node.left, vars, fns);
      collect(node.right, vars, fns);
      return;
    case 'call':
      fns.add(node.name);
      for (const a of node.args) collect(a, vars, fns);
      return;
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function parseFormula(source: string): ParsedFormula {
  if (typeof source !== 'string') {
    throw new FormulaError('FORMULA_SYNTAX', 'La formule doit être une chaîne de caractères.', 0);
  }
  if (source.length > FORMULA_MAX_LENGTH) {
    throw new FormulaError('FORMULA_LIMIT', `Formule trop longue (${source.length} > ${FORMULA_MAX_LENGTH} caractères).`, FORMULA_MAX_LENGTH);
  }
  const ast = new Parser(tokenize(source)).parseFormula();
  const vars = new Set<string>();
  const fns = new Set<string>();
  collect(ast, vars, fns);
  return { source, ast, variables: [...vars].sort(byCodeUnit), functions: [...fns].sort(byCodeUnit) };
}
