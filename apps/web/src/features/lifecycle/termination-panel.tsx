import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPostForm, errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Icon } from '../../ui/icons.js';
import { useToast } from '../../ui/toast.js';
import { ReasonDialog } from './reason-dialog.js';
import { useContractAction } from './use-contract-action.js';

const fmt = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');

/**
 * Résiliation enregistrée (TERMINATION_PENDING / TERMINATED) : date d'effet,
 * courrier de résiliation scanné (pièce justificative, PDF), retrait de la
 * résiliation avant sa prise d'effet (motif obligatoire).
 */
export function TerminationPanel({ contractId, status, terminationEffectiveDate, allowedActions, me }: {
  contractId: string;
  status: string;
  terminationEffectiveDate: string | null | undefined;
  allowedActions: string[];
  me: Me | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const withdraw = useContractAction(contractId, 'withdraw-termination');
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('letter', f, f.name);
      return apiPostForm<{ id: string; sha256: string }>(`/v1/contracts/${contractId}/termination-letter`, form);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contract', contractId] });
      void qc.invalidateQueries({ queryKey: ['lifecycle', contractId] });
    },
  });

  if (status !== 'TERMINATION_PENDING' && status !== 'TERMINATED') return null;
  const canAct = allows(me, 'contracts.lifecycle');

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    upload.reset();
    setFileError(f && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name) ? 'Le courrier de résiliation doit être un PDF.' : null);
    setFile(f);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (file && !fileError) upload.mutate(file); };

  return (
    <Card title="Résiliation">
      <div className="flex flex-col gap-3 text-sm">
        <p className="flex items-center gap-2">
          <Icon name="calendarX" />
          {status === 'TERMINATION_PENDING'
            ? <>Résiliation enregistrée : prise d’effet le <strong>{fmt(terminationEffectiveDate)}</strong>. Le contrat reste en vigueur jusque-là.</>
            : <>Contrat résilié{terminationEffectiveDate ? <> le <strong>{fmt(terminationEffectiveDate)}</strong></> : null}.</>}
        </p>
        {canAct && (
          <form onSubmit={submit} className="flex flex-col gap-2 rounded border border-line px-3 py-2">
            <label htmlFor="term-letter" className="text-xs+ font-button text-ink-muted">Courrier de résiliation scanné (PDF)</label>
            <input id="term-letter" type="file" accept="application/pdf,.pdf" onChange={pick} className="text-sm" />
            {fileError && <p role="alert" className="text-danger">{fileError}</p>}
            {upload.error ? <p role="alert" className="text-danger">{errorMessage(upload.error)}</p> : null}
            {upload.data && (
              <p role="status" className="text-success">
                Courrier joint au contrat. Empreinte SHA-256 : <code className="break-all text-xs">{upload.data.sha256}</code>
              </p>
            )}
            <div>
              <Button type="submit" size="sm" variant="secondary" disabled={!file || !!fileError || upload.isPending}>
                {upload.isPending ? 'Envoi…' : 'Joindre le courrier'}
              </Button>
            </div>
          </form>
        )}
        {canAct && allowedActions.includes('WITHDRAW_TERMINATION') && (
          <div>
            <Button type="button" variant="warn" onClick={() => setWithdrawing(true)}>Retirer la résiliation</Button>
          </div>
        )}
        <ReasonDialog
          open={withdrawing} title="Retirer la résiliation" label="Motif du retrait"
          intro={<p>Le contrat redevient actif ; les échéances de résiliation sont annulées.</p>}
          confirmLabel="Confirmer le retrait" pending={withdraw.isPending} error={withdraw.error}
          onClose={() => { setWithdrawing(false); withdraw.reset(); }}
          onConfirm={(reason) => withdraw.mutate({ reason }, { onSuccess: () => { toast.show('Résiliation retirée : le contrat est de nouveau actif.', 'success'); setWithdrawing(false); } })}
        />
      </div>
    </Card>
  );
}
