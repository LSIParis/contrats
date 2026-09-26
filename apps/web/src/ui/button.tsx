import type { ButtonHTMLAttributes } from 'react';

/**
 * Bouton — gabarit lticket (apps/console/src/styles.css l. 212-236) :
 * rayon 6 px, 8×14 px, graisse 550, primaire menthe 800 → survol menthe 900,
 * désactivé à 50 %. Le focus clavier est l'anneau global `--focus` (index.css).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'warn';

const VARIANTS: Record<ButtonVariant, string> = {
  // `button, .btn` (l. 212-218)
  primary: 'border-transparent bg-primary text-white hover:bg-primary-hover',
  // `.btn-secondary` (l. 220, 228)
  secondary: 'border-line-strong bg-surface text-ink hover:bg-slate-100',
  // `.btn-ghost` (l. 229-230)
  ghost: 'border-transparent bg-transparent px-2.5 py-1.5 text-primary hover:bg-mint-50',
  // `.btn-danger` (l. 233-234)
  danger: 'border-transparent bg-danger text-white hover:bg-danger-hover',
  // `.btn-danger-ghost` (l. 572-573)
  'danger-ghost': 'border-transparent bg-transparent px-2.5 py-1.5 text-danger hover:bg-danger-bg',
  // `.btn-warn` (l. 224-225)
  warn: 'border-warn bg-warn-bg text-warn hover:bg-[#F6E5C6]',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: 'md' | 'sm' = 'md'): string {
  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm';
  return `inline-flex items-center justify-center gap-2 rounded border font-button no-underline transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${VARIANTS[variant]}`;
}

export function Button({
  className = '',
  variant = 'primary',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'md' | 'sm' }) {
  // Pas de `type` imposé : le comportement natif (submit dans un formulaire) est conservé.
  return <button className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}
