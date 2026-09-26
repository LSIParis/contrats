import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portalGet, portalPost, PortalUnauthorized } from './portal-api.js';
import { AccountChip, NavItem, Shell, Sidebar, Topbar } from '../ui/layout.js';
import { Icon } from '../ui/icons.js';

interface PortalMe {
  email: string;
  customerName: string;
}

export function PortalLayout() {
  const navigate = useNavigate();
  const me = useQuery({
    queryKey: ['portal-me'],
    queryFn: () => portalGet<PortalMe>('/v1/portal/me'),
    retry: false,
  });

  useEffect(() => {
    if (me.error instanceof PortalUnauthorized) navigate('/portal/login', { replace: true });
  }, [me.error, navigate]);

  async function handleLogout() {
    try {
      await portalPost('/v1/portal/auth/logout', {});
    } finally {
      navigate('/portal/login', { replace: true });
    }
  }

  if (me.error instanceof PortalUnauthorized) return null;

  // Même coquille que la console (et que le portail de lticket : barre latérale + barre de titre).
  return (
    <Shell
      sidebar={
        <Sidebar
          appName="Espace client"
          bottom={
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2.5 rounded bg-transparent px-2.5 py-2 text-left font-medium text-slate-200 hover:bg-white/[.06] hover:text-white"
            >
              <span className="opacity-[.85]"><Icon name="logout" /></span>
              Déconnexion
            </button>
          }
        >
          <NavItem to="/portal/contracts" icon="contract">Mes contrats</NavItem>
        </Sidebar>
      }
      topbar={
        <Topbar title="Espace client — LSI Maintenance">
          {me.data?.email && <AccountChip name={me.data.customerName || me.data.email} detail={me.data.email} />}
        </Topbar>
      }
    >
      <Outlet />
    </Shell>
  );
}
