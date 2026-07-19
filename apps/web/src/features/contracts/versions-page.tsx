import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

interface VersionRow { id: string; versionNumber: number; changeSummary: string | null; createdAt: string; }

export function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['versions', id], queryFn: () => apiGet<{ items: VersionRow[] }>(`/v1/contracts/${id}/versions`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Erreur de chargement.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Historique des versions</h1>
      {q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucune version.</p>
      ) : (
        <Table head={<tr><th className="py-2">Version</th><th>Résumé</th><th>Date</th></tr>}>
          {q.data.items.map((v) => (
            <tr key={v.id} className="border-b">
              <td className="py-2">Version {v.versionNumber}</td>
              <td>{v.changeSummary ?? '—'}</td>
              <td>{new Date(v.createdAt).toLocaleDateString('fr-FR')}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
