import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { StatusBadge } from '../../ui/badge.js';

interface Row {
  id: string; reference: string; title: string;
  customer: { name: string }; status: string; endDate: string | null;
}
interface ListResponse { data: Row[]; pagination: { nextCursor: string | null; hasMore: boolean }; }

export function ContractsPage() {
  const [params] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');

  const query = useInfiniteQuery({
    queryKey: ['contracts', status, q],
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
      if (q.trim()) sp.set('q', q.trim());
      if (pageParam) sp.set('cursor', pageParam);
      return apiGet<ListResponse>(`/v1/contracts?${sp.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? lastPage.pagination.nextCursor ?? undefined : undefined),
  });

  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Contrats</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher (référence, titre)…"
        className="w-72 rounded border px-3 py-1.5 text-sm"
      />
      {query.isLoading ? (
        <Spinner />
      ) : query.error || !query.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-400">Aucun contrat.</p>
      ) : (
        <>
          <Table head={<tr><th className="py-2">Référence</th><th>Titre</th><th>Client</th><th>Statut</th><th>Échéance</th></tr>}>
            {rows.map((c) => (
              <tr key={c.id} className="border-b hover:bg-gray-50">
                <td className="py-2"><Link to={`/contracts/${c.id}`} className="text-lsi hover:underline">{c.reference}</Link></td>
                <td>{c.title}</td>
                <td>{c.customer.name}</td>
                <td><StatusBadge status={c.status} /></td>
                <td>{c.endDate ? new Date(c.endDate).toLocaleDateString('fr-FR') : '—'}</td>
              </tr>
            ))}
          </Table>
          {query.hasNextPage ? (
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {query.isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
