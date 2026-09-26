import { describe, test, expect } from 'vitest';
import {
  D,
  tokenize,
  parseFormula,
  evaluateFormula,
  evaluateExpression,
  validateFormula,
  FormulaError,
  FORMULA_MAX_LENGTH,
  FORMULA_MAX_DEPTH,
  type Decimal,
} from '../src/index.js';

const vars = (o: Record<string, string>): Record<string, Decimal> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, D(v)]));

const ev = (expr: string, v: Record<string, string> = {}) => evaluateExpression(expr, vars(v)).toString();

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as FormulaError).code;
  }
  return undefined;
};

describe('tokenize', () => {
  test('nombres, identifiants, opérateurs, positions', () => {
    const t = tokenize('P0 * (a + 0.85)>=1');
    expect(t.map((x) => x.value)).toEqual(['P0', '*', '(', 'a', '+', '0.85', ')', '>=', '1', '']);
    expect(t[1]).toMatchObject({ type: 'op', pos: 3 });
    expect(t.at(-1)?.type).toBe('eof');
  });
  test('caractère inconnu → FORMULA_SYNTAX avec position', () => {
    try {
      tokenize('a + $b');
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaError);
      expect((e as FormulaError).code).toBe('FORMULA_SYNTAX');
      expect((e as FormulaError).position).toBe(4);
    }
  });
  test('nombres mal formés refusés (« 1. », « .5 », « 1e3 », virgule décimale)', () => {
    expect(codeOf(() => tokenize('1.'))).toBe('FORMULA_SYNTAX');
    expect(codeOf(() => tokenize('.5'))).toBe('FORMULA_SYNTAX');
    expect(codeOf(() => parseFormula('1e3'))).toBe('FORMULA_SYNTAX');
    expect(codeOf(() => parseFormula('1,5'))).toBe('FORMULA_SYNTAX');
  });
});

describe('parseFormula — précédence et associativité', () => {
  test.each([
    ['1 + 2 * 3', '7'],
    ['(1 + 2) * 3', '9'],
    ['10 - 4 - 3', '3'],
    ['100 / 10 / 5', '2'],
    ['2 ^ 3 ^ 2', '512'], // ^ associatif à droite
    ['-2 ^ 2', '-4'], // le moins unaire lie plus faiblement que ^
    ['2 ^ -1', '0.5'],
    ['--3', '3'],
    ['+3 - -3', '6'],
    ['1 + 2 < 4', '1'],
    ['3 >= 4', '0'],
    ['2 == 2.0', '1'],
    ['2 != 2', '0'],
    ['0.1 + 0.2', '0.3'], // exact, pas de flottant binaire
  ])('%s = %s', (expr, expected) => {
    expect(ev(expr)).toBe(expected);
  });

  test('AST exposé pour l’interface (variables et fonctions utilisées)', () => {
    const f = parseFormula('max(P0, a * S1 / S0)');
    expect(f.variables).toEqual(['P0', 'S0', 'S1', 'a']);
    expect(f.functions).toEqual(['max']);
    expect(f.ast.type).toBe('call');
  });

  test('erreurs de syntaxe', () => {
    for (const bad of ['', '1 +', '(1 + 2', '1 + 2)', 'a b', 'max(1,)', 'f(', '1 < 2 < 3', '*2']) {
      expect(codeOf(() => parseFormula(bad)), bad).toBe('FORMULA_SYNTAX');
    }
  });

  test('garde de longueur', () => {
    const long = '1+'.repeat(FORMULA_MAX_LENGTH) + '1';
    expect(codeOf(() => parseFormula(long))).toBe('FORMULA_LIMIT');
  });

  test('garde de profondeur (parenthèses et moins unaires imbriqués)', () => {
    const deep = '('.repeat(FORMULA_MAX_DEPTH + 1) + '1' + ')'.repeat(FORMULA_MAX_DEPTH + 1);
    expect(codeOf(() => parseFormula(deep))).toBe('FORMULA_LIMIT');
    const deepUnary = '-'.repeat(FORMULA_MAX_DEPTH + 1) + '1';
    expect(codeOf(() => parseFormula(deepUnary))).toBe('FORMULA_LIMIT');
    const ok = '('.repeat(10) + '1' + ')'.repeat(10);
    expect(ev(ok)).toBe('1');
  });
});

describe('evaluateFormula — fonctions en liste blanche', () => {
  test.each([
    ['min(3, 1, 2)', '1'],
    ['max(3, 1, 2)', '3'],
    ['round(2.345, 2)', '2.35'],
    ['round(-2.345, 2)', '-2.35'],
    ['round(2.5)', '3'],
    ['floor(2.9)', '2'],
    ['floor(-2.1)', '-3'],
    ['ceil(2.1)', '3'],
    ['abs(-4.5)', '4.5'],
    ['if(1 > 2, 10, 20)', '20'],
    ['if(qty >= 10, 5, 7)', '5'],
  ])('%s = %s', (expr, expected) => {
    expect(ev(expr, { qty: '12' })).toBe(expected);
  });

  test('round suit le mode d’arrondi configuré', () => {
    const f = parseFormula('round(0.125, 2)');
    expect(evaluateFormula(f, {}, { rounding: 'HALF_EVEN' }).toString()).toBe('0.12');
    expect(evaluateFormula(f, {}).toString()).toBe('0.13');
  });

  test('if est paresseux : la branche non retenue n’est pas évaluée', () => {
    expect(ev('if(S0 == 0, 0, 1 / S0)', { S0: '0' })).toBe('0');
  });

  test('fonction inconnue → FORMULA_UNKNOWN_FUNCTION (pas d’accès à l’environnement JS)', () => {
    for (const bad of ['eval(1)', 'constructor(1)', 'sqrt(4)', 'Math(1)']) {
      expect(codeOf(() => ev(bad)), bad).toBe('FORMULA_UNKNOWN_FUNCTION');
    }
  });

  test('mauvaise arité → FORMULA_ARITY', () => {
    for (const bad of ['abs(1, 2)', 'if(1, 2)', 'round(1, 2, 3)', 'min()']) {
      expect(codeOf(() => ev(bad)), bad).toBe('FORMULA_ARITY');
    }
  });

  test('variable inconnue → FORMULA_UNKNOWN_VARIABLE, y compris les noms du prototype', () => {
    expect(codeOf(() => ev('a + 1'))).toBe('FORMULA_UNKNOWN_VARIABLE');
    expect(codeOf(() => ev('toString + 1'))).toBe('FORMULA_UNKNOWN_VARIABLE');
    expect(codeOf(() => ev('__proto__ + 1'))).toBe('FORMULA_UNKNOWN_VARIABLE');
  });

  test('division par zéro → DIVISION_BY_ZERO', () => {
    expect(codeOf(() => ev('1 / (a - a)', { a: '3' }))).toBe('DIVISION_BY_ZERO');
    expect(codeOf(() => ev('0 ^ -1'))).toBe('DIVISION_BY_ZERO');
  });

  test('exposant non entier ou démesuré → FORMULA_EVALUATION', () => {
    expect(codeOf(() => ev('2 ^ 0.5'))).toBe('FORMULA_EVALUATION');
    expect(codeOf(() => ev('2 ^ 1000'))).toBe('FORMULA_EVALUATION');
  });

  test('round : nombre de décimales entier entre 0 et 10', () => {
    expect(codeOf(() => ev('round(1, 1.5)'))).toBe('FORMULA_EVALUATION');
    expect(codeOf(() => ev('round(1, 11)'))).toBe('FORMULA_EVALUATION');
  });

  test('formule de révision écrite en expression', () => {
    const r = ev('P0 * (a + b * S1 / S0)', { P0: '1250', a: '0.15', b: '0.85', S0: '321.5', S1: '333.2' });
    // Valeur exacte (fractions rationnelles) : 1288.66640746500777604976671850699844479004665…
    // Précision de travail : 40 chiffres significatifs — on compare sur 30 décimales.
    expect(D(r).toDecimalPlaces(30).toFixed(30)).toBe('1288.666407465007776049766718506998');
  });
});

describe('validateFormula — erreurs structurées pour l’interface', () => {
  test('formule valide : variables et fonctions utilisées', () => {
    expect(validateFormula('round(P0 * S1 / S0, 2)', ['P0', 'S0', 'S1'])).toEqual({
      valid: true,
      variables: ['P0', 'S0', 'S1'],
      functions: ['round'],
      errors: [],
    });
  });

  test('collecte TOUTES les variables et fonctions inconnues, avec positions', () => {
    const r = validateFormula('x + foo(y) + abs(1, 2)', ['a']);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([
      { code: 'FORMULA_UNKNOWN_VARIABLE', name: 'x', position: 0, message: expect.any(String) },
      { code: 'FORMULA_UNKNOWN_FUNCTION', name: 'foo', position: 4, message: expect.any(String) },
      { code: 'FORMULA_UNKNOWN_VARIABLE', name: 'y', position: 8, message: expect.any(String) },
      { code: 'FORMULA_ARITY', name: 'abs', position: 13, message: expect.any(String) },
    ]);
  });

  test('erreur de syntaxe : une seule erreur, positionnée', () => {
    const r = validateFormula('1 + * 2', []);
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: 'FORMULA_SYNTAX', position: 4 });
  });
});
