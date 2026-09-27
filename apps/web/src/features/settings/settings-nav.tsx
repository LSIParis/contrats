import { NavLink } from 'react-router-dom';

/**
 * Sous-navigation des paramètres du tenant — même barre soulignée que les onglets lticket
 * (`.tabbar`, styles.css l. 604-608), mais en LIENS : chaque écran a son adresse
 * (/settings, /settings/api, /settings/webhooks), `aria-current="page"` sur l'actif.
 */
const LINKS: Array<[to: string, label: string]> = [
  ['/settings', 'Général et IA'],
  ['/settings/api', 'API publique'],
  ['/settings/webhooks', 'Webhooks sortants'],
];

export function SettingsNav() {
  return (
    <nav aria-label="Sections des paramètres" className="mb-1 flex flex-wrap gap-1 border-b border-line">
      {LINKS.map(([to, label]) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            `-mb-px inline-flex items-center whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-button no-underline ${
              isActive ? 'border-primary text-primary' : 'border-transparent text-ink-muted hover:text-ink'
            }`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
