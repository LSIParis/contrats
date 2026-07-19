import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, apiDelete, ApiError } from '../../lib/api.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { partyLabel } from '../../lib/labels.js';

export interface Signer { id: string; party: string; fullName: string; email: string; signingOrder: number; }

function AddForm({ contractId, party, onDone }: { contractId: string; party: 'LSI' | 'CLIENT'; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', email: '' });
  const m = useMutation({
    mutationFn: () => apiPost(`/v1/contracts/${contractId}/signers`, { party, fullName: form.fullName.trim(), email: form.email.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] }); onDone(); },
  });
  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.fullName.trim() && form.email.trim();
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <Field label="Nom" htmlFor={`sn-${party}`}><Input id={`sn-${party}`} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
      <Field label="Email" htmlFor={`se-${party}`}><Input id={`se-${party}`} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-3 py-1.5 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">Ajouter</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function SignersBlock({ contractId, signers, editable }: { contractId: string; signers: Signer[]; editable: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<'LSI' | 'CLIENT' | null>(null);
  const del = useMutation({
    mutationFn: (signerId: string) => apiDelete(`/v1/contracts/${contractId}/signers/${signerId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contract', contractId] }); qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] }); },
  });
  return (
    <Card title="Signataires">
      {signers.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun signataire.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {signers.map((s) => (
            <li key={s.id} className="flex items-center justify-between">
              <span><span>{s.fullName}</span> <span className="text-gray-400">({partyLabel(s.party)})</span> — {s.email}</span>
              {editable && <button type="button" onClick={() => del.mutate(s.id)} className="text-xs text-red-600 hover:underline">Retirer</button>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setAdding('LSI')} className="rounded border px-3 py-1.5 text-sm">+ Signataire LSI</button>
          <button type="button" onClick={() => setAdding('CLIENT')} className="rounded border px-3 py-1.5 text-sm">+ Signataire client</button>
        </div>
      )}
      {editable && adding && <AddForm contractId={contractId} party={adding} onDone={() => setAdding(null)} />}
    </Card>
  );
}
