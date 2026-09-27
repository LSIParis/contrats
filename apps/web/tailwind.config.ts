import type { Config } from 'tailwindcss';
import { mint, petrol, slate, semantic, role, radius, shadow, font, layout } from './src/ui/theme/tokens';

/**
 * Tailwind aligné sur le système de design de lticket
 * (LSIParis/ticket, apps/console/src/styles.css — voir src/ui/theme/tokens.ts).
 *
 * - `gray` est REMPLACÉE par l'échelle slate de lticket : toutes les classes `text-gray-*`,
 *   `bg-gray-*` et la bordure par défaut prennent ainsi les neutres de lticket sans toucher
 *   aux pages.
 * - `lsi` (anciennement #0b5cad, provisoire) devient le primaire de lticket (menthe 800) et son
 *   survol (menthe 900).
 * - `rounded` = rayon des boutons/champs lticket (6 px), `rounded-lg` = rayon des cartes (10 px).
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: slate,
        slate,
        mint,
        petrol,
        lsi: { DEFAULT: role.primary, dark: role.primaryHover },
        primary: { DEFAULT: role.primary, hover: role.primaryHover },
        accent: role.accent,
        focus: role.focus,
        page: role.bg,
        surface: role.surface,
        line: { DEFAULT: role.border, strong: role.borderStrong },
        ink: { DEFAULT: role.text, muted: role.textMuted, faint: role.textFaint },
        success: { DEFAULT: semantic.success, bg: semantic.successBg },
        warn: { DEFAULT: semantic.warn, bg: semantic.warnBg },
        danger: { DEFAULT: semantic.danger, bg: semantic.dangerBg, hover: semantic.dangerHover },
        info: { DEFAULT: semantic.info, bg: semantic.infoBg },
        // Messages d'erreur existants (`text-red-600`, `bg-red-600`) : rouge danger de lticket.
        red: { 600: semantic.danger, 700: semantic.dangerHover },
      },
      borderColor: { DEFAULT: role.border },
      borderRadius: { DEFAULT: radius.sm, sm: radius.sm, md: radius.sm, lg: radius.md, xl: radius.lg, full: radius.full },
      boxShadow: { sm: shadow.sm, DEFAULT: shadow.md, md: shadow.lg, lg: shadow.pop, pop: shadow.pop },
      fontFamily: { sans: [font.family], mono: [font.mono] },
      fontWeight: { button: '550', title: '650', heading: '680' },
      fontSize: {
        '2xs': ['11px', '1.25'],
        'xs+': ['12.5px', '1.5'],
        '13': ['13px', '1.5'],
        '15': ['15px', '1.4'],
        '17': ['17px', '1.4'],
        '18': ['18px', '1.35'],
        '22': ['22px', '1.3'],
      },
      spacing: { sidebar: layout.sidebarWidth, topbar: layout.topbarHeight },
      maxWidth: { content: layout.contentMax },
      ringColor: { DEFAULT: role.focus },
    },
  },
  plugins: [],
} satisfies Config;
