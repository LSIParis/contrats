import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

interface CustomerRow { id: string; name: string; siren: string | null; country: string; contractCount: number; }

export function CustomersPage() {
  const q = useQuery({ queryKey: ['customers'], queryFn: () => apiGet<{ items: CustomerRow[] }>('/v1/customers') });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Link to="/customers/new" className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">Nouveau client</Link>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucun client. Créez-en un pour commencer.</p>
      ) : (
        <Table head={<tr><th className="py-2">Nom</th><th>SIREN</th><th>Contrats</th></tr>}>
          {q.data.items.map((c) => (
            <tr key={c.id} className="border-b hover:bg-gray-50">
              <td className="py-2"><Link to={`/customers/${c.id}`} className="text-lsi hover:underline">{c.name}</Link></td>
              <td>{c.siren ?? '—'}</td>
              <td>{c.contractCount}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
