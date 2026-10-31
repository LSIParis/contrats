/**
 * Jetons de la charte graphique LSI Contrats, déclinés du logo
 * (docs/contrats/10-charte-graphique.md).
 *
 * Toute évolution est à reporter ici ET dans `tokens.css` : le test `theme-tokens.test.ts`
 * vérifie que les deux fichiers restent d'accord.
 *
 * Ce fichier alimente `tailwind.config.ts` (classes utilitaires) et les tests de contraste.
 */

/** Cobalt (action, information) : le L bleu du logo. */
export const cobalt = {
  50: '#EEF3FE',
  100: '#DFE8FD',
  200: '#C3D4FB',
  300: '#9DBBFE',
  400: '#6C9DFF',
  500: '#3D7BFF',
  600: '#2F62E6',
  700: '#2457E0',
  800: '#1A39A6',
  900: '#122A7E',
  950: '#0A1748',
} as const;

/** Cuivre (signature de marque, jamais un état) : le L cuivré du logo. */
export const copper = {
  50: '#FDF6EF',
  100: '#FBEBDB',
  200: '#F8D1A8',
  300: '#F6C79A',
  400: '#E9A672',
  500: '#DE9158',
  600: '#C9773D',
  700: '#A85A28',
  800: '#7A3A16',
  900: '#4A200B',
} as const;

/** Nuit (surfaces sombres : barre latérale) : le fond du logo. */
export const night = {
  700: '#1C3170',
  800: '#16285A',
  900: '#0B1530',
  950: '#060C1E',
} as const;

/** Ivoire (fonds de marque : connexion, supports imprimés). */
export const ivory = '#F3F1EC';

/** Slate (neutres). Remplace aussi l'échelle `gray` de Tailwind. */
export const slate = {
  50: '#F9FAFB',
  100: '#F3F5F6',
  200: '#E5E9EB',
  300: '#CED5DA',
  400: '#96A5B0',
  500: '#677B89',
  600: '#53636E',
  700: '#424E57',
  800: '#303940',
  900: '#232A2F',
  950: '#14171A',
} as const;

/** Sémantiques : chaque ton est lisible sur son propre fond à 4,5:1. */
export const semantic = {
  success: '#117F3A',
  successBg: '#E7F6EC',
  warn: '#B25209',
  warnBg: '#FBF0DD',
  danger: '#D12424',
  dangerBg: '#FCE9E9',
  /** Survol du bouton danger. */
  dangerHover: '#B91C1C',
  info: cobalt[700],
  infoBg: cobalt[50],
} as const;

/** Rôles. */
export const role = {
  bg: slate[50],
  surface: '#FFFFFF',
  border: slate[200],
  borderStrong: slate[300],
  text: slate[900],
  textMuted: slate[600],
  /** Assombri par rapport à slate-500 pour passer 4,5:1 sur blanc. */
  textFaint: '#637684',
  primary: cobalt[700],
  primaryHover: cobalt[800],
  /** Décoratif, sur fond nuit uniquement (contraste insuffisant sur blanc). */
  accent: copper[400],
  /** Anneau de focus (≥ 3:1, WCAG 1.4.11). */
  focus: cobalt[600],
  /** Voile des modales. */
  overlay: 'rgba(11, 21, 48, .45)',
} as const;

/** Forme. */
export const radius = { sm: '6px', md: '10px', lg: '14px', full: '999px' } as const;

export const shadow = {
  sm: '0 1px 2px rgba(11,21,48,.06)',
  md: '0 1px 3px rgba(11,21,48,.08), 0 1px 2px rgba(11,21,48,.04)',
  lg: '0 4px 12px rgba(11,21,48,.08)',
  pop: '0 8px 28px rgba(11,21,48,.16)',
} as const;

/** Espacements (identiques à l'échelle Tailwind 1/2/3/4/6/8). */
export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' } as const;

/** Gabarit. */
export const layout = { sidebarWidth: '248px', contentMax: '1180px', topbarHeight: '60px' } as const;

/** Typographie auto-hébergée : Sora (titres, logo) via `@fontsource-variable/sora`, Inter (texte). */
export const font = {
  display: "'Sora Variable', 'Segoe UI', system-ui, sans-serif",
  family: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  /** Échelle (px). */
  size: { '2xs': '11px', xs: '12px', 'xs+': '12.5px', sm: '13px', base: '14px', md: '15px', lg: '17px', xl: '18px', '2xl': '22px', '3xl': '26px' },
  /** Graisses nommées (550 boutons/onglets, 650 titres, 680 en-tête de fiche). */
  weight: { regular: 400, medium: 500, button: 550, semibold: 600, title: 650, heading: 680, bold: 700 },
} as const;
