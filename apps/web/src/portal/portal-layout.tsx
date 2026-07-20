import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portalGet, portalPost, PortalUnauthorized } from './portal-api.js';

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

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b bg-white p-4">
        <span className="font-semibold text-lsi">Espace client — LSI Maintenance</span>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          {me.data?.email && <span>{me.data.email}</span>}
          <button type="button" onClick={handleLogout} className="text-lsi hover:underline">
            Déconnexion
          </button>
        </div>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
