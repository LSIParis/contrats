import type { ReactNode } from 'react';

/**
 * Carte — `.card` de lticket (apps/console/src/styles.css l. 196-201) : surface blanche,
 * bordure slate 200, rayon 10 px, 20 px de marge intérieure, ombre `--shadow-sm`, contenu
 * empilé à 12 px. Titre : `.card > h2:first-child` (l. 202), 15 px, graisse 650.
 */
export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h2 className="text-15 font-title text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
}
