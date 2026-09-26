import type { SelectHTMLAttributes } from 'react';
import { controlClass } from './input.js';

/** Liste déroulante — même gabarit que les champs lticket (styles.css l. 270-283). */
export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${controlClass} ${className}`} {...props} />;
}
