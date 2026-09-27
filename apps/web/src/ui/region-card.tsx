import { useId, type ReactNode } from 'react';

/**
 * Carte nommée : même gabarit que `Card` (`.card` de lticket, styles.css l. 196-202), mais la
 * section est reliée à son titre (`aria-labelledby`) — c'est un repère « region » pour les
 * lecteurs d'écran, utile sur les écrans longs (tarification, administration).
 */
export function RegionCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-15 font-title text-ink">{title}</h2>
        {actions}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** Message d'erreur serveur (`detail`), annoncé immédiatement. */
export function ErrorNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">{children}</p>;
}
