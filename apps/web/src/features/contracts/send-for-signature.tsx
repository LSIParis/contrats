import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { partyLabel } from '../../lib/labels.js';

interface Signer { id: string; party: string; fullName: string; email: string; signingOrder: number; }

export function SendForSignature({
  contractId, signers, allowedActions, roles,
}: {
  contractId: string; signers: Signer[]; allowedActions: string[]; roles: string[];
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const send = useMutation({
    mutationFn: () =>
      apiPost(`/v1/contracts/${contractId}/send-for-signature`, {}, {
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      setConfirming(false);
    },
  });

  const canSend =
    allowedActions.includes('SEND_FOR_SIGNATURE') &&
    roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  if (!canSend) return null;

  const error = send.error instanceof ApiError ? send.error.message : send.error ? 'Erreur.' : undefined;
  const sorted = [...signers].sort((a, b) => a.signingOrder - b.signingOrder);

  return (
    <div className="space-y-2">
      {!confirming ? (
        <button type="button" className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark" onClick={() => setConfirming(true)}>
          Envoyer en signature
        </button>
      ) : (
        <div className="space-y-3 rounded border p-3">
          <p className="text-sm font-medium">Confirmer l’envoi en signature</p>
          <p className="text-sm text-gray-600">Des emails de signature vont être envoyés à ces personnes, dans l’ordre :</p>
          <ul className="text-sm">
            {sorted.map((s) => (
              <li key={s.id}>{s.signingOrder + 1}. {s.fullName} <span className="text-gray-400">({partyLabel(s.party)})</span> — {s.email}</li>
            ))}
          </ul>
          <a href={`/v1/contracts/${contractId}/preview.pdf`} target="_blank" rel="noopener" className="text-sm text-lsi hover:underline">Aperçu PDF</a>
          <div className="flex gap-2">
            <button type="button" disabled={send.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50" onClick={() => send.mutate()}>
              {send.isPending ? 'Envoi…' : 'Confirmer l’envoi'}
            </button>
            <button type="button" className="rounded border px-4 py-2 text-sm" onClick={() => setConfirming(false)}>Annuler</button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
