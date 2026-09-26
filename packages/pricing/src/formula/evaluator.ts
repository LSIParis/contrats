import { FormulaError } from '../errors.js';
import { D, Decimal, roundToScale, type RoundingMode } from '../money.js';
import { parseFormula, type FormulaNode, type ParsedFormula } from './parser.js';

/**
 * Évaluateur d'AST sur decimal.js.
 *
 * Tout est décimal exact (40 chiffres significatifs) : `0.1 + 0.2` vaut 0.3,
 * pas 0.30000000000000004. Les booléens n'existent pas en tant que type : une
 * comparaison vaut 1 ou 0, et `if(c, a, b)` retient `a` si `c ≠ 0`.
 *
 * Liste blanche de fonctions. Toute autre fonction est refusée — y compris
 * celles qui « existent » en JavaScript : `eval`, `constructor`, `sqrt`… Le
 * nom n'est jamais résolu dans un objet JavaScript : il est comparé à une
 * table fermée (Map), donc `__proto__` ou `toString` ne peuvent rien atteindre.
 */

export interface FunctionSpec {
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly signature: string;
}

export const FORMULA_FUNCTIONS: ReadonlyMap<string, FunctionSpec> = new Map([
  ['min', { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, signature: 'min(x, y, …)' }],
  ['max', { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, signature: 'max(x, y, …)' }],
  ['round', { minArgs: 1, maxArgs: 2, signature: 'round(x) ou round(x, n)' }],
  ['floor', { minArgs: 1, maxArgs: 1, signature: 'floor(x)' }],
  ['ceil', { minArgs: 1, maxArgs: 1, signature: 'ceil(x)' }],
  ['abs', { minArgs: 1, maxArgs: 1, signature: 'abs(x)' }],
  ['if', { minArgs: 3, maxArgs: 3, signature: 'if(condition, siVrai, siFaux)' }],
]);

/** Borne de l'exposant de `^` : entier, |n| ≤ 100. Une puissance sert à capitaliser sur des années, pas plus. */
export const FORMULA_MAX_EXPONENT = 100;
/** Borne du nombre de décimales de round(x, n). */
export const FORMULA_MAX_ROUND_DECIMALS = 10;

export interface EvaluateOptions {
  /** Mode d'arrondi de la fonction round() — le même que celui du barème. */
  readonly rounding?: RoundingMode;
}

const ONE = D(1);
const ZERO = D(0);

function arityError(name: string, spec: FunctionSpec, got: number, pos: number): FormulaError {
  return new FormulaError(
    'FORMULA_ARITY',
    `${name}() reçoit ${got} argument(s) à la position ${pos} ; forme attendue : ${spec.signature}.`,
    pos,
    { name },
  );
}

function evalNode(node: FormulaNode, vars: ReadonlyMap<string, Decimal>, opts: EvaluateOptions): Decimal {
  switch (node.type) {
    case 'number':
      return D(node.value);

    case 'variable': {
      const v = vars.get(node.name);
      if (v === undefined) {
        throw new FormulaError('FORMULA_UNKNOWN_VARIABLE', `Variable inconnue « ${node.name} » à la position ${node.pos}.`, node.pos, {
          name: node.name,
        });
      }
      return v;
    }

    case 'unary': {
      const x = evalNode(node.operand, vars, opts);
      return node.op === '-' ? x.neg() : x;
    }

    case 'binary': {
      const l = evalNode(node.left, vars, opts);
      const r = evalNode(node.right, vars, opts);
      switch (node.op) {
        case '+':
          return l.plus(r);
        case '-':
          return l.minus(r);
        case '*':
          return l.times(r);
        case '/':
          if (r.isZero()) {
            throw new FormulaError('DIVISION_BY_ZERO', `Division par zéro à la position ${node.pos}.`, node.pos);
          }
          return l.div(r);
        case '^': {
          if (!r.isInteger() || r.abs().gt(FORMULA_MAX_EXPONENT)) {
            throw new FormulaError(
              'FORMULA_EVALUATION',
              `Exposant ${r.toString()} refusé à la position ${node.pos} : entier entre -${FORMULA_MAX_EXPONENT} et ${FORMULA_MAX_EXPONENT} attendu.`,
              node.pos,
            );
          }
          if (l.isZero() && r.isNegative()) {
            throw new FormulaError('DIVISION_BY_ZERO', `0 élevé à une puissance négative à la position ${node.pos}.`, node.pos);
          }
          return l.pow(r);
        }
        case '<':
          return l.lt(r) ? ONE : ZERO;
        case '<=':
          return l.lte(r) ? ONE : ZERO;
        case '>':
          return l.gt(r) ? ONE : ZERO;
        case '>=':
          return l.gte(r) ? ONE : ZERO;
        case '==':
          return l.eq(r) ? ONE : ZERO;
        case '!=':
          return l.eq(r) ? ZERO : ONE;
      }
      // Exhaustivité garantie par le type BinaryOp : le compilateur sait que
      // l'on ne sort jamais de ce switch sans return.
    }

    case 'call': {
      const spec = FORMULA_FUNCTIONS.get(node.name);
      if (!spec) {
        throw new FormulaError(
          'FORMULA_UNKNOWN_FUNCTION',
          `Fonction « ${node.name} » non autorisée à la position ${node.pos}. Fonctions permises : ${[...FORMULA_FUNCTIONS.keys()].join(', ')}.`,
          node.pos,
          { name: node.name },
        );
      }
      const n = node.args.length;
      if (n < spec.minArgs || n > spec.maxArgs) throw arityError(node.name, spec, n, node.pos);

      // if() est PARESSEUX : seule la branche retenue est évaluée, ce qui permet
      // d'écrire if(S0 == 0, 0, P0 / S0) sans déclencher la division par zéro.
      if (node.name === 'if') {
        const [c, a, b] = node.args as [FormulaNode, FormulaNode, FormulaNode];
        return evalNode(c, vars, opts).isZero() ? evalNode(b, vars, opts) : evalNode(a, vars, opts);
      }

      const args = node.args.map((a) => evalNode(a, vars, opts));
      const x = args[0] as Decimal;
      switch (node.name) {
        case 'min':
          return Decimal.min(...args);
        case 'max':
          return Decimal.max(...args);
        case 'floor':
          return x.floor();
        case 'ceil':
          return x.ceil();
        case 'abs':
          return x.abs();
        case 'round': {
          const places = args[1] ?? ZERO;
          if (!places.isInteger() || places.isNegative() || places.gt(FORMULA_MAX_ROUND_DECIMALS)) {
            throw new FormulaError(
              'FORMULA_EVALUATION',
              `round() : le nombre de décimales doit être un entier entre 0 et ${FORMULA_MAX_ROUND_DECIMALS} (position ${node.pos}).`,
              node.pos,
            );
          }
          return roundToScale(x, places.toNumber(), opts.rounding ?? 'HALF_AWAY_FROM_ZERO');
        }
      }
      throw new FormulaError('FORMULA_UNKNOWN_FUNCTION', `Fonction « ${node.name} » non implémentée.`, node.pos, { name: node.name });
    }
  }
}

/**
 * Évalue une formule déjà analysée. `variables` est un objet simple ; il est
 * recopié dans une Map, de sorte qu'aucune clé héritée du prototype d'Object
 * (`toString`, `__proto__`…) ne peut être résolue comme variable.
 */
export function evaluateFormula(
  formula: ParsedFormula,
  variables: Readonly<Record<string, Decimal>>,
  opts: EvaluateOptions = {},
): Decimal {
  const vars = new Map<string, Decimal>();
  for (const k of Object.keys(variables)) {
    const v = variables[k];
    if (v !== undefined) vars.set(k, v);
  }
  const result = evalNode(formula.ast, vars, opts);
  if (!result.isFinite()) {
    throw new FormulaError('FORMULA_EVALUATION', 'Le résultat de la formule n’est pas un nombre fini.', null);
  }
  return result;
}

/** Raccourci : analyse + évaluation. */
export function evaluateExpression(
  source: string,
  variables: Readonly<Record<string, Decimal>>,
  opts: EvaluateOptions = {},
): Decimal {
  return evaluateFormula(parseFormula(source), variables, opts);
}
