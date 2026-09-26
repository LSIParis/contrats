/**
 * Jetons du système de design — reproduction fidèle de lticket.
 *
 * SOURCE : dépôt LSIParis/ticket, `apps/console/src/styles.css` (bloc `:root`, l. 6-63).
 * Le portail client de lticket (`apps/portal/src/styles.css`) reprend la même palette.
 * Aucun paquet partagé n'existe encore : ces valeurs sont RECOPIÉES, pas importées.
 * Toute évolution côté lticket doit être reportée ici ET dans `tokens.css` — le test
 * `theme-tokens.test.ts` vérifie que les deux fichiers restent d'accord.
 *
 * Ce fichier alimente `tailwind.config.ts` (classes utilitaires) et les tests de contraste.
 */

/** Menthe (accent) — styles.css l. 8-10. */
export const mint = {
  50: '#F3FCF9',
  100: '#E6F9F3',
  200: '#C8F4E6',
  300: '#93ECD0',
  400: '#56E6B8',
  500: '#1BDA9D',
  600: '#16B683',
  700: '#13966C',
  800: '#0F7B59',
  900: '#0B5B42',
  950: '#062D21',
} as const;

/** Pétrole (surfaces sombres : barre latérale) — styles.css l. 12. */
export const petrol = {
  700: '#3B5E6D',
  800: '#304D5A',
  900: '#243942',
  950: '#121D21',
} as const;

/** Slate (neutres) — styles.css l. 14-16. Remplace aussi l'échelle `gray` de Tailwind. */
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

/** Sémantiques : chaque ton est lisible sur son propre fond à 4,5:1 — styles.css l. 28-31. */
export const semantic = {
  success: '#117F3A',
  successBg: '#E7F6EC',
  warn: '#B25209',
  warnBg: '#FBF0DD',
  danger: '#D12424',
  dangerBg: '#FCE9E9',
  /** Survol du bouton danger — styles.css l. 234 (`.btn-danger:hover`). */
  dangerHover: '#B91C1C',
  info: mint[800],
  infoBg: mint[50],
} as const;

/** Rôles — styles.css l. 34-49. */
export const role = {
  bg: slate[50],
  surface: '#FFFFFF',
  border: slate[200],
  borderStrong: slate[300],
  text: slate[900],
  textMuted: slate[600],
  /** Assombri par rapport à slate-500 pour passer 4,5:1 sur blanc (l. 40-42). */
  textFaint: '#637684',
  primary: mint[800],
  primaryHover: mint[900],
  accent: mint[500],
  /** Anneau de focus : 3,75:1 sur blanc (WCAG 1.4.11) — l. 46-49. */
  focus: mint[700],
  /** Voile des modales — styles.css l. 749 (`.modal-fond`). */
  overlay: 'rgba(18, 29, 33, .45)',
} as const;

/** Forme — styles.css l. 52-56. */
export const radius = { sm: '6px', md: '10px', lg: '14px', full: '999px' } as const;

export const shadow = {
  sm: '0 1px 2px rgba(18,29,33,.06)',
  md: '0 1px 3px rgba(18,29,33,.08), 0 1px 2px rgba(18,29,33,.04)',
  lg: '0 4px 12px rgba(18,29,33,.08)',
  pop: '0 8px 28px rgba(18,29,33,.16)',
} as const;

/** Espacements — styles.css l. 57 (identiques à l'échelle Tailwind 1/2/3/4/6/8). */
export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' } as const;

/** Gabarit — styles.css l. 58-59, 145-153. */
export const layout = { sidebarWidth: '248px', contentMax: '1180px', topbarHeight: '60px' } as const;

/**
 * Typographie — styles.css l. 60, 67-77 ; polices chargées par `@fontsource/inter`
 * (apps/console/src/main.tsx l. 3-6 : graisses 400/500/600/700). lticket n'utilise
 * QUE Inter — pas de DM Sans pour les titres.
 */
export const font = {
  family: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  /** Échelle relevée dans la feuille lticket (px). */
  size: { '2xs': '11px', xs: '12px', 'xs+': '12.5px', sm: '13px', base: '14px', md: '15px', lg: '17px', xl: '18px', '2xl': '22px', '3xl': '26px' },
  /** Graisses nommées par lticket (550 boutons/onglets, 650 titres, 680 en-tête de fiche). */
  weight: { regular: 400, medium: 500, button: 550, semibold: 600, title: 650, heading: 680, bold: 700 },
} as const;
