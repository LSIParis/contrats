import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

const IN_PROGRESS = ['PENDING_SIGNATURE', 'PARTIALLY_SIGNED'];

export function SignatureActions({ contractId, status, roles }: { contractId: string; status: string; roles: string[] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const canAct = IN_PROGRESS.includes(status) && roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));

  const remind = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signature/remind`, {}),
  });
  const revoke = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signature/revoke`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setConfirming(false);
    },
  });

  if (!canAct) return null;
  const err = (m: typeof remind | typeof revoke) => (m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={remind.isPending} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => remind.mutate()}>
          {remind.isPending ? 'Relance…' : 'Relancer'}
        </button>
        <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setConfirming(true)}>Révoquer</button>
      </div>
      {remind.isSuccess && <p className="text-sm text-green-700">Relance envoyée.</p>}
      {err(remind) && <p className="text-sm text-red-600">{err(remind)}</p>}
      {confirming && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">La demande de signature sera annulée ; le contrat redeviendra approuvé (vous pourrez le renvoyer).</p>
          <div className="flex gap-2">
            <button type="button" disabled={revoke.isPending} className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50" onClick={() => revoke.mutate()}>
              {revoke.isPending ? 'Révocation…' : 'Confirmer la révocation'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setConfirming(false)}>Annuler</button>
          </div>
          {err(revoke) && <p className="text-sm text-red-600">{err(revoke)}</p>}
        </div>
      )}
    </div>
  );
}
