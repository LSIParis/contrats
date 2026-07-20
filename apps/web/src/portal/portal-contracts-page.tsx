import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portalGet, PortalUnauthorized } from './portal-api.js';
import { Spinner } from '../ui/spinner.js';
import { Table } from '../ui/table.js';
import { StatusBadge } from '../ui/badge.js';

interface PortalContractRow {
  id: string;
  reference: string;
  title: string;
  status: string;
  endDate: string | null;
}
interface PortalContractsResponse {
  items: PortalContractRow[];
}

export function PortalContractsPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['portal-contracts'],
    queryFn: () => portalGet<PortalContractsResponse>('/v1/portal/contracts'),
    retry: false,
  });

  useEffect(() => {
    if (query.error instanceof PortalUnauthorized) navigate('/portal/login', { replace: true });
  }, [query.error, navigate]);

  if (query.isLoading) return <Spinner />;
  if (query.error || !query.data) return <p className="text-red-600">Erreur de chargement.</p>;
  const rows = query.data.items;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Mes contrats</h1>
      {rows.length === 0 ? (
        <p className="text-gray-400">Aucun contrat.</p>
      ) : (
        <Table head={<tr><th className="py-2">Référence</th><th>Titre</th><th>Statut</th><th>Échéance</th></tr>}>
          {rows.map((c) => (
            <tr key={c.id} className="border-b hover:bg-gray-50">
              <td className="py-2"><Link to={`/portal/contracts/${c.id}`} className="text-lsi hover:underline">{c.reference}</Link></td>
              <td>{c.title}</td>
              <td><StatusBadge status={c.status} /></td>
              <td>{c.endDate ? new Date(c.endDate).toLocaleDateString('fr-FR') : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
