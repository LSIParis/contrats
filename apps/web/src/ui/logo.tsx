/**
 * Logo LSI Contrats (docs/contrats/10-charte-graphique.md §2).
 * Interface : symbole plat, seule version lisible sous 64 px. Le symbole en relief et les
 * logos vectorisés sont dans `public/brand/`.
 */
const SYMBOL_COLORS = {
  light: { first: '#2457E0', second: '#C9773D' },
  dark: { first: '#6C9DFF', second: '#E9A672' },
} as const;

export function LogoSymbol({ tone = 'light', size = 28 }: { tone?: 'light' | 'dark'; size?: number }) {
  const { first, second } = SYMBOL_COLORS[tone];
  return (
    <svg width={size} height={size} viewBox="34 34 132 132" aria-hidden="true" className="shrink-0">
      <path d="M40 40 H80 V120 H106 V160 H40 Z" fill={first} stroke={first} strokeWidth="6" strokeLinejoin="round" />
      <path d="M94 40 H160 V160 H120 V80 H94 Z" fill={second} stroke={second} strokeWidth="6" strokeLinejoin="round" />
      <path d="M100 90 L110 100 L100 110 L90 100 Z" fill={second} stroke={second} strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

/** Symbole et nom de l'application ; `dark` : sur fond nuit (barre latérale). */
export function Logo({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  return (
    <span role="img" aria-label="LSI Contrats" className="inline-flex items-center gap-2.5 font-display text-[19px] leading-none tracking-[-0.035em]">
      <LogoSymbol tone={tone} />
      <span aria-hidden="true" className="inline-flex items-baseline gap-[.28em]">
        <span className={`font-bold ${tone === 'dark' ? 'text-[#F4F2EE]' : 'text-night-900'}`}>LSI</span>
        <span className={`font-light ${tone === 'dark' ? 'text-copper-400' : 'text-copper-700'}`}>Contrats</span>
      </span>
    </span>
  );
}
