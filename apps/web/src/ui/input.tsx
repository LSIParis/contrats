import type { InputHTMLAttributes } from 'react';

/**
 * Champ de saisie — `input` de lticket (apps/console/src/styles.css l. 270-283) : 8×10 px,
 * bordure slate 300, rayon 6 px ; focus : bordure menthe 700 + halo (règle de base, index.css).
 */
export const controlClass =
  'w-full rounded border border-line-strong bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-ink-muted aria-[invalid=true]:border-danger';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlClass} ${className}`} {...props} />;
}
