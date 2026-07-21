import { Link, Outlet } from 'react-router-dom';
import { useMe } from '../lib/queries.js';
import { NotificationBell } from '../features/notifications/notification-bell.js';

export function AppShell() {
  const me = useMe();
  return (
    <div className="flex min-h-screen">
      <nav className="w-56 bg-lsi-dark p-4 text-white">
        <div className="mb-6 font-semibold">LSI Contrats</div>
        <ul className="space-y-2">
          <li><Link to="/dashboard">Tableau de bord</Link></li>
          <li><Link to="/customers">Clients</Link></li>
          <li><Link to="/contracts">Contrats</Link></li>
          <li><Link to="/reminders">Rappels</Link></li>
          {me.data?.roles?.includes('MSP_ADMIN') && <li><Link to="/users">Utilisateurs</Link></li>}
        </ul>
      </nav>
      <div className="flex-1">
        <header className="flex items-center justify-end gap-4 border-b p-3 text-sm text-gray-600">
          <NotificationBell />
          <span>{me.data?.fullName} · {me.data?.roles?.join(', ')}</span>
        </header>
        <main className="p-6"><Outlet /></main>
      </div>
    </div>
  );
}
