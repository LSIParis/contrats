import { FormulaError, type PricingErrorCode } from '../errors.js';
import { FORMULA_FUNCTIONS } from './evaluator.js';
import { parseFormula, type FormulaNode } from './parser.js';

/**
 * Validation d'une formule pour l'éditeur de barème.
 *
 * Contrairement à l'évaluateur, qui s'arrête à la première erreur, la
 * validation COLLECTE toutes les erreurs sémantiques (variables inconnues,
 * fonctions hors liste blanche, arités) avec leur position, pour que
 * l'interface les souligne toutes d'un coup. Une erreur de syntaxe, elle,
 * interrompt l'analyse : au-delà, l'arbre n'existe pas.
 *
 * Ne lève jamais : renvoie toujours un résultat structuré.
 */

export interface FormulaIssue {
  readonly code: PricingErrorCode;
  readonly message: string;
  readonly position: number | null;
  readonly name?: string;
}

export interface FormulaValidationResult {
  readonly valid: boolean;
  readonly variables: readonly string[];
  readonly functions: readonly string[];
  readonly errors: readonly FormulaIssue[];
}

function walk(node: FormulaNode, allowed: ReadonlySet<string>, out: FormulaIssue[]): void {
  switch (node.type) {
    case 'number':
      return;
    case 'variable':
      if (!allowed.has(node.name)) {
        out.push({
          code: 'FORMULA_UNKNOWN_VARIABLE',
          name: node.name,
          position: node.pos,
          message: `Variable inconnue « ${node.name} ». Variables disponibles : ${[...allowed].join(', ') || 'aucune'}.`,
        });
      }
      return;
    case 'unary':
      walk(node.operand, allowed, out);
      return;
    case 'binary':
      walk(node.left, allowed, out);
      walk(node.right, allowed, out);
      return;
    case 'call': {
      const spec = FORMULA_FUNCTIONS.get(node.name);
      if (!spec) {
        out.push({
          code: 'FORMULA_UNKNOWN_FUNCTION',
          name: node.name,
          position: node.pos,
          message: `Fonction « ${node.name} » non autorisée. Fonctions permises : ${[...FORMULA_FUNCTIONS.keys()].join(', ')}.`,
        });
      } else if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
        out.push({
          code: 'FORMULA_ARITY',
          name: node.name,
          position: node.pos,
          message: `${node.name}() reçoit ${node.args.length} argument(s) ; forme attendue : ${spec.signature}.`,
        });
      }
      for (const a of node.args) walk(a, allowed, out);
      return;
    }
  }
}

export function validateFormula(expr: string, allowedVariables: readonly string[]): FormulaValidationResult {
  try {
    const parsed = parseFormula(expr);
    const errors: FormulaIssue[] = [];
    walk(parsed.ast, new Set(allowedVariables), errors);
    errors.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return { valid: errors.length === 0, variables: parsed.variables, functions: parsed.functions, errors };
  } catch (e) {
    if (e instanceof FormulaError) {
      return {
        valid: false,
        variables: [],
        functions: [],
        errors: [{ code: e.code, message: e.message, position: e.position }],
      };
    }
    throw e;
  }
}
