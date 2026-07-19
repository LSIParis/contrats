import type { SelectHTMLAttributes } from 'react';

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`w-full rounded border px-3 py-1.5 text-sm ${className}`} {...props} />;
}
