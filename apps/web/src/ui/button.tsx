import type { ButtonHTMLAttributes } from 'react';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
