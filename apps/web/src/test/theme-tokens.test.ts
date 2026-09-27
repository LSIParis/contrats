import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mint, petrol, slate, semantic, role } from '../ui/theme/tokens.js';
import { contrastRatio } from '../ui/theme/contrast.js';

// Vitest s'exécute depuis apps/web (environnement jsdom : import.meta.url n'est pas un file://).
const css = readFileSync(resolve(process.cwd(), 'src/ui/theme/tokens.css'), 'utf8');

/** Valeur d'une variable CSS déclarée dans tokens.css. */
function cssVar(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m?.[1]) throw new Error(`--${name} absent de tokens.css`);
  return m[1].trim();
}

test('tokens.css et tokens.ts portent les mêmes valeurs (échelles lticket)', () => {
  for (const [k, v] of Object.entries(mint)) expect(cssVar(`mint-${k}`).toUpperCase()).toBe(v.toUpperCase());
  for (const [k, v] of Object.entries(petrol)) expect(cssVar(`petrol-${k}`).toUpperCase()).toBe(v.toUpperCase());
  for (const [k, v] of Object.entries(slate)) expect(cssVar(`slate-${k}`).toUpperCase()).toBe(v.toUpperCase());
});

test('tokens.css et tokens.ts portent les mêmes rôles et sémantiques', () => {
  const pairs: Array<[string, string]> = [
    ['success', semantic.success], ['success-bg', semantic.successBg],
    ['warn', semantic.warn], ['warn-bg', semantic.warnBg],
    ['danger', semantic.danger], ['danger-bg', semantic.dangerBg],
    ['info', semantic.info], ['info-bg', semantic.infoBg],
    ['bg', role.bg], ['surface', role.surface], ['border', role.border], ['border-strong', role.borderStrong],
    ['text', role.text], ['text-muted', role.textMuted], ['text-faint', role.textFaint],
    ['primary', role.primary], ['primary-hover', role.primaryHover], ['accent', role.accent], ['focus', role.focus],
  ];
  for (const [name, value] of pairs) expect(cssVar(name).toUpperCase()).toBe(value.toUpperCase());
});

test('le calcul de contraste est conforme à la référence WCAG', () => {
  expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  // Valeur annoncée par lticket (styles.css l. 43) : primaire sur blanc 5,25:1.
  expect(contrastRatio(role.primary, '#FFFFFF')).toBeCloseTo(5.25, 1);
});

describe('contrastes AA (≥ 4,5:1) des jetons de texte et de bouton', () => {
  const cases: Array<[string, string, string]> = [
    ['texte principal sur page', role.text, role.bg],
    ['texte principal sur surface', role.text, role.surface],
    ['texte atténué sur surface', role.textMuted, role.surface],
    ['texte atténué sur page', role.textMuted, role.bg],
    ['texte discret sur surface', role.textFaint, role.surface],
    ['texte discret sur page', role.textFaint, role.bg],
    ['lien / primaire sur surface', role.primary, role.surface],
    ['bouton primaire (blanc sur menthe 800)', '#FFFFFF', role.primary],
    ['bouton primaire survolé (blanc sur menthe 900)', '#FFFFFF', role.primaryHover],
    ['bouton danger (blanc sur danger)', '#FFFFFF', semantic.danger],
    ['bouton danger survolé', '#FFFFFF', semantic.dangerHover],
    ['bouton secondaire (texte sur surface)', role.text, role.surface],
    ['barre latérale : entrée (slate 200 sur pétrole 900)', slate[200], petrol[900]],
    ['barre latérale : libellé de section (slate 400 sur pétrole 900)', slate[400], petrol[900]],
    ['message d’erreur (danger sur surface)', semantic.danger, role.surface],
  ];
  test.each(cases)('%s', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
