import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cobalt, copper, ivory, night, slate, semantic, role } from '../ui/theme/tokens.js';
import { contrastRatio } from '../ui/theme/contrast.js';

// Vitest s'exécute depuis apps/web (environnement jsdom : import.meta.url n'est pas un file://).
const css = readFileSync(resolve(process.cwd(), 'src/ui/theme/tokens.css'), 'utf8');

/** Valeur d'une variable CSS déclarée dans tokens.css. */
function cssVar(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m?.[1]) throw new Error(`--${name} absent de tokens.css`);
  return m[1].trim();
}

test('tokens.css et tokens.ts portent les mêmes valeurs (échelles de la charte)', () => {
  for (const [k, v] of Object.entries(cobalt)) expect(cssVar(`cobalt-${k}`).toUpperCase()).toBe(v.toUpperCase());
  for (const [k, v] of Object.entries(copper)) expect(cssVar(`copper-${k}`).toUpperCase()).toBe(v.toUpperCase());
  for (const [k, v] of Object.entries(night)) expect(cssVar(`night-${k}`).toUpperCase()).toBe(v.toUpperCase());
  expect(cssVar('ivory').toUpperCase()).toBe(ivory.toUpperCase());
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
  expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
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
    ['bouton primaire (blanc sur cobalt 700)', '#FFFFFF', role.primary],
    ['bouton primaire survolé (blanc sur cobalt 800)', '#FFFFFF', role.primaryHover],
    ['bouton danger (blanc sur danger)', '#FFFFFF', semantic.danger],
    ['bouton danger survolé', '#FFFFFF', semantic.dangerHover],
    ['bouton secondaire (texte sur surface)', role.text, role.surface],
    ['barre latérale : entrée (slate 200 sur nuit 900)', slate[200], night[900]],
    ['barre latérale : libellé de section (slate 400 sur nuit 900)', slate[400], night[900]],
    ['barre latérale : sous-titre (slate 300 sur nuit 900)', slate[300], night[900]],
    ['logo : « Contrats » sur nuit (cuivre 400)', copper[400], night[900]],
    ['logo : « Contrats » sur surface (cuivre 700)', copper[700], role.surface],
    ['information (cobalt 700 sur cobalt 50)', semantic.info, semantic.infoBg],
    ['message d’erreur (danger sur surface)', semantic.danger, role.surface],
  ];
  test.each(cases)('%s', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrastes graphiques (≥ 3:1, WCAG 1.4.11)', () => {
  const cases: Array<[string, string, string]> = [
    ['anneau de focus sur surface', role.focus, role.surface],
    ['anneau de focus sur page', role.focus, role.bg],
    ['logo : « Contrats » sur ivoire (grand texte, cuivre 700)', copper[700], ivory],
    ['symbole plat cobalt sur surface', cobalt[700], role.surface],
    ['symbole plat cuivre sur surface', copper[600], role.surface],
    ['symbole plat cobalt clair sur nuit', cobalt[400], night[900]],
    ['symbole plat cuivre clair sur nuit', copper[400], night[900]],
  ];
  test.each(cases)('%s', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});
