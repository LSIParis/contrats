import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];

function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TerminateContract({
  contractId, customerName, noticePeriodDays, roles, allowedActions,
}: {
  contractId: string; customerName: string; noticePeriodDays: number | null; roles: string[]; allowedActions: string[];
}) {
  const qc = useQueryClient();
  const notice = noticePeriodDays ?? 0;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [initiatedBy, setInitiatedBy] = useState<'LSI' | 'CLIENT'>('LSI');
  const [effectiveDate, setEffectiveDate] = useState(plusDays(notice));
  const [overrideReason, setOverrideReason] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const isAdmin = roles.includes('MSP_ADMIN');
  const canAct = allowedActions.includes('TERMINATE') && roles.some((r) => ADMIN_OR_AM.includes(r));
  const beforeNotice = effectiveDate < plusDays(notice);

  const m = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/terminate`, {
      reason: reason.trim(), effectiveDate, initiatedBy,
      ...(isAdmin && beforeNotice ? { overrideReason: overrideReason.trim() } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setOpen(false);
    },
  });

  if (!canAct) return null;
  const err = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const nameOk = confirmName.trim() === customerName.trim();
  const overrideOk = !(isAdmin && beforeNotice) || overrideReason.trim().length > 0;
  const ready = reason.trim().length > 0 && nameOk && overrideOk && !m.isPending;

  if (!open) {
    return (
      <button type="button" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600" onClick={() => setOpen(true)}>
        Résilier
      </button>
    );
  }

  return (
    <form className="space-y-3 rounded border border-red-200 p-4" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <p className="text-sm font-medium text-red-700">Résiliation du contrat</p>
      <label className="block text-sm">Motif
        <textarea aria-label="Motif" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <label className="block text-sm">Initié par
        <select className="mt-1 w-full rounded border p-2" value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value as 'LSI' | 'CLIENT')}>
          <option value="LSI">LSI</option>
          <option value="CLIENT">Client</option>
        </select>
      </label>
      <label className="block text-sm">Date d'effet {notice > 0 && <span className="text-gray-500">(préavis {notice} j → au plus tôt le {plusDays(notice)})</span>}
        <input type="date" aria-label="Date d'effet" className="mt-1 w-full rounded border p-2" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
      </label>
      {isAdmin && beforeNotice && (
        <label className="block text-sm text-amber-700">Justification de la dérogation au préavis (obligatoire)
          <textarea aria-label="Justification de la dérogation" className="mt-1 w-full rounded border p-2" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
        </label>
      )}
      {beforeNotice && !isAdmin && <p className="text-sm text-red-600">La date précède la fin du préavis : seul un administrateur peut déroger.</p>}
      <label className="block text-sm">Tapez le nom du client (<span className="font-medium">{customerName}</span>) pour confirmer
        <input aria-label={`Tapez le nom du client (${customerName})`} className="mt-1 w-full rounded border p-2" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
      </label>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!ready} className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
          {m.isPending ? 'Résiliation…' : 'Confirmer la résiliation'}
        </button>
        <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </form>
  );
}
