import { Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../lib/queries.js';
import { canDo } from '../lib/permissions.js';
import { roleLabel } from '../lib/labels.js';
import { NotificationBell } from '../features/notifications/notification-bell.js';
import { AccountChip, NavItem, NavSection, Shell, Sidebar, Topbar } from '../ui/layout.js';
import { allows } from '../lib/permissions.js';

/** Titre de la barre supérieure selon la section (comme `TITLES` dans lticket, App.tsx). */
const SECTION_TITLES: Array<[prefix: string, title: string]> = [
  ['/dashboard', 'Tableau de bord'],
  ['/customers', 'Clients'],
  ['/contracts', 'Contrats'],
  ['/reminders', 'Rappels'],
  ['/users', 'Utilisateurs'],
  ['/audit', 'Journal d’audit'],
  ['/templates', 'Modèles de contrat'],
  ['/library', 'Bibliothèque de clauses'],
  ['/settings', 'Paramètres'],
  ['/pricing', 'Tarification'],
  ['/proposal-admin', 'Propositions'],
];

function sectionTitle(pathname: string): string {
  return SECTION_TITLES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`))?.[1] ?? 'LSI Contrats';
}

export function AppShell() {
  const me = useMe();
  const { pathname } = useLocation();
  const roles = me.data?.roles ?? [];
  const isAdmin = roles.includes('MSP_ADMIN');
  const canTemplates = isAdmin || roles.includes('LEGAL_REVIEWER');

  return (
    <Shell
      sidebar={
        <Sidebar appName="Contrats">
          <NavItem to="/dashboard" icon="dash">Tableau de bord</NavItem>
          <NavItem to="/customers" icon="building">Clients</NavItem>
          <NavItem to="/contracts" icon="contract">Contrats</NavItem>
          <NavItem to="/reminders" icon="bell">Rappels</NavItem>
          {(allows(me.data, 'contracts.write') || allows(me.data, 'clauses.manage')) && (
            <NavItem to="/library" icon="book">Bibliothèque de clauses</NavItem>
          )}
          {canDo(me.data, 'pricing.simulate') && <NavItem to="/pricing" icon="tag">Tarification</NavItem>}
          {(isAdmin || canTemplates) && (
            <NavSection label="Administration">
              {canTemplates && <NavItem to="/templates" icon="book">Modèles</NavItem>}
              {isAdmin && <NavItem to="/users" icon="users">Utilisateurs</NavItem>}
              {isAdmin && <NavItem to="/audit" icon="clipboard">Audit</NavItem>}
              {isAdmin && <NavItem to="/settings" icon="settings">Paramètres</NavItem>}
              {isAdmin && <NavItem to="/proposal-admin/pending" icon="fileCheck">Prix à valider</NavItem>}
            </NavSection>
          )}
        </Sidebar>
      }
      topbar={
        <Topbar title={sectionTitle(pathname)}>
          <NotificationBell />
          {me.data?.fullName && (
            <AccountChip name={me.data.fullName} detail={roles.map(roleLabel).join(', ') || undefined} />
          )}
        </Topbar>
      }
    >
      <Outlet />
    </Shell>
  );
}
