import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

interface Approval { submittedByUserId: string; decision: string; reason: string | null; decidedByUserId: string | null; }

export function WorkflowActions({
  contractId, allowedActions, roles, currentUserId, approval,
}: {
  contractId: string; status: string; allowedActions: string[]; roles: string[]; currentUserId: string; approval: Approval | null;
}) {
  const qc = useQueryClient();
  const [reasonFor, setReasonFor] = useState<null | 'request-changes' | 'cancel'>(null);
  const [reason, setReason] = useState('');

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => apiPost(`/v1/contracts/${contractId}/${path}`, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setReasonFor(null); setReason('');
    },
  });

  const can = (a: string) => allowedActions.includes(a);
  const isSubmitter = approval?.submittedByUserId === currentUserId;
  const canSubmit = roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  const canReview = roles.some((r) => ['MSP_ADMIN', 'LEGAL_REVIEWER'].includes(r));
  const error = act.error instanceof ApiError ? act.error.message : act.error ? 'Erreur.' : undefined;

  const btn = 'rounded px-4 py-2 text-sm text-white disabled:opacity-50';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {can('SUBMIT_FOR_REVIEW') && canSubmit && (
          <button type="button" disabled={act.isPending} className={`${btn} bg-lsi hover:bg-lsi-dark`} onClick={() => act.mutate({ path: 'submit' })}>Soumettre</button>
        )}
        {can('APPROVE') && canReview && !isSubmitter && (
          <button type="button" disabled={act.isPending} className={`${btn} bg-green-600 hover:bg-green-700`} onClick={() => act.mutate({ path: 'approve' })}>Approuver</button>
        )}
        {can('REQUEST_CHANGES') && canReview && !isSubmitter && (
          <button type="button" className={`${btn} bg-amber-600 hover:bg-amber-700`} onClick={() => setReasonFor('request-changes')}>Demander des modifications</button>
        )}
        {can('CANCEL') && canSubmit && (
          <button type="button" className={`${btn} bg-red-600 hover:bg-red-700`} onClick={() => setReasonFor('cancel')}>Annuler</button>
        )}
      </div>
      {approval && (
        <p className="text-sm text-gray-500">
          Approbation : {approval.decision === 'PENDING' ? 'en attente de revue' : approval.decision === 'APPROVED' ? 'approuvé' : `modifications demandées${approval.reason ? ` — ${approval.reason}` : ''}`}
        </p>
      )}
      {reasonFor && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) act.mutate({ path: reasonFor, body: { reason: reason.trim() } }); }}>
          <textarea className="w-full rounded border p-2 text-sm" placeholder="Motif (obligatoire)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <button type="submit" disabled={!reason.trim() || act.isPending} className={`${btn} bg-lsi hover:bg-lsi-dark`}>Confirmer</button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => { setReasonFor(null); setReason(''); }}>Annuler</button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
