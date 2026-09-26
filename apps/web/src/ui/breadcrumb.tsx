import { Link } from 'react-router-dom';

/**
 * Fil d'Ariane — reprise de lticket : `nav.breadcrumb` « Parent › Page » (pages/Dns.tsx l. 94)
 * posé dans l'espace `.crumb` (apps/console/src/styles.css l. 559 : 12 px sous le fil).
 * Liens en primaire, page courante en texte atténué avec `aria-current="page"` (RGAA 12.2).
 */
export type Crumb = { label: string; to?: string };

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Fil d'Ariane" className="mb-3 text-13">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="inline-flex items-center gap-1.5">
              {c.to && !last ? (
                <Link to={c.to} className="text-primary hover:underline">{c.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className="text-ink-muted">{c.label}</span>
              )}
              {!last && <span aria-hidden="true" className="text-ink-faint">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
