import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];
interface Ref { id?: string; reference: string; status?: string; }
interface Renewal { status: string; newContractId: string | null; successor: Ref | null; }

export function RenewContract({ contractId, status, roles, renewal, predecessor }: {
  contractId: string; status: string; roles: string[];
  renewal: Renewal | null; predecessor: { id: string; reference: string } | null;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState('');
  const canAct = roles.some((r) => ADMIN_OR_AM.includes(r));

  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/v1/contracts/${contractId}/renew`, {}),
    onSuccess: (r) => nav(`/contracts/${r.id}`),
  });
  const refuse = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/renew/refuse`, { reason: reason.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); setRefusing(false); },
  });

  const errOf = (m: typeof create | typeof refuse) => (m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined);
  const renewable = (status === 'ACTIVE' || status === 'EXPIRED')
    && (!renewal || renewal.status === 'REFUSED' || renewal.status === 'EXPIRED');
  const active = renewal && renewal.status === 'PENDING';

  return (
    <div className="space-y-2">
      {predecessor && (
        <p className="text-sm text-gray-600">Renouvellement de <Link className="text-lsi hover:underline" to={`/contracts/${predecessor.id}`}>{predecessor.reference}</Link></p>
      )}
      {renewal && renewal.successor && (
        <p className="text-sm text-gray-600">
          Renouvellement → {renewal.newContractId
            ? <Link className="text-lsi hover:underline" to={`/contracts/${renewal.newContractId}`}>{renewal.successor.reference}</Link>
            : renewal.successor.reference} ({renewal.status})
        </p>
      )}
      {canAct && renewable && (
        <button type="button" disabled={create.isPending} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => create.mutate()}>
          {create.isPending ? 'Création…' : 'Renouveler'}
        </button>
      )}
      {errOf(create) && <p className="text-sm text-red-600">{errOf(create)}</p>}
      {canAct && active && !refusing && (
        <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setRefusing(true)}>Refuser</button>
      )}
      {refusing && (
        <div className="space-y-2 rounded border p-3">
          <label className="block text-sm">Motif du refus
            <textarea aria-label="Motif" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {errOf(refuse) && <p className="text-sm text-red-600">{errOf(refuse)}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!reason.trim() || refuse.isPending} className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => refuse.mutate()}>Confirmer le refus</button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setRefusing(false)}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}
