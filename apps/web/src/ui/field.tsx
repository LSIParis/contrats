import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * Champ de formulaire — `.field` de lticket (apps/console/src/styles.css l. 493-497) :
 * libellé 12,5 px graisse 550 atténué au-dessus du contrôle, 5 px d'écart, aide en 12 px.
 *
 * Accessibilité (RGAA 11.1 / 11.10) : le libellé est TOUJOURS relié au contrôle par
 * `htmlFor` ; l'erreur et l'aide sont reliées par `aria-describedby`, et l'erreur pose
 * `aria-invalid` sur le contrôle quand l'enfant est un élément unique.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  const hintId = hint ? `${htmlFor}-aide` : undefined;
  const errorId = error ? `${htmlFor}-erreur` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control =
    describedBy && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-describedby': describedBy,
          ...(error ? { 'aria-invalid': true } : {}),
        })
      : children;
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <label htmlFor={htmlFor} className="text-xs+ font-button text-ink-muted">{label}</label>
      {control}
      {hint && <p id={hintId} className="text-xs text-ink-faint">{hint}</p>}
      {error && <p id={errorId} className="text-13 text-danger">{error}</p>}
    </div>
  );
}
