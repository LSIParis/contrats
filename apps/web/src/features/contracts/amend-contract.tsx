import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { apiPost, ApiError } from '../../lib/api.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];

/** « 1500,50 » → 150050 centimes ; vide → undefined. */
function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

export function AmendContract({ contractId, status, roles, openAmendment, amends }: {
  contractId: string; status: string; roles: string[];
  openAmendment: { id: string; reference: string; status: string } | null;
  amends: { id: string; reference: string } | null;
}) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [amount, setAmount] = useState('');
  const canAct = roles.some((r) => ADMIN_OR_AM.includes(r));
  const amendable = (status === 'ACTIVE' || status === 'SIGNED') && !openAmendment;

  const m = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/v1/contracts/${contractId}/amend`, {
      reason: reason.trim(),
      ...(endDate ? { endDate } : {}),
      ...(eurosToCents(amount) !== undefined ? { amountCents: eurosToCents(amount) } : {}),
    }),
    onSuccess: (r) => nav(`/contracts/${r.id}`),
  });
  const err = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <div className="space-y-2">
      {amends && (
        <p className="text-sm text-gray-600">Avenant de <Link className="text-lsi hover:underline" to={`/contracts/${amends.id}`}>{amends.reference}</Link></p>
      )}
      {openAmendment && (
        <p className="text-sm text-gray-600">Avenant en cours → <Link className="text-lsi hover:underline" to={`/contracts/${openAmendment.id}`}>{openAmendment.reference}</Link> ({openAmendment.status})</p>
      )}
      {canAct && amendable && !open && (
        <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>Créer un avenant</button>
      )}
      {open && (
        <form className="space-y-3 rounded border p-4" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) m.mutate(); }}>
          <p className="text-sm font-medium">Nouvel avenant</p>
          <label className="block text-sm">Description
            <textarea aria-label="Description" className="mt-1 w-full rounded border p-2" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="flex gap-3">
            <label className="block text-sm">Nouvelle date de fin
              <input type="date" aria-label="Nouvelle date de fin" className="mt-1 w-full rounded border p-2" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="block text-sm">Nouveau montant (€)
              <input aria-label="Nouveau montant" className="mt-1 w-full rounded border p-2" placeholder="inchangé" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={!reason.trim() || m.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white disabled:opacity-50">
              {m.isPending ? 'Création…' : 'Créer l’avenant'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setOpen(false)}>Annuler</button>
          </div>
        </form>
      )}
    </div>
  );
}
