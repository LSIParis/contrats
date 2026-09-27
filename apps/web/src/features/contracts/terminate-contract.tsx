import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, errorMessage } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Icon } from '../../ui/icons.js';
import { useToast } from '../../ui/toast.js';

const ADMIN_OR_AM = ['MSP_ADMIN', 'ACCOUNT_MANAGER'];

/** GET /v1/contracts/:id/termination-preview (apps/api/src/renewal/renewal.service.ts). */
export interface TerminationPreview {
  effectiveDate: string;
  deadlineMissed: boolean;
  noticeDeadline: string | null;
  currentPeriodEnd: string | null;
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');

/**
 * Résiliation (brief §2, lot 5) : la date d'effet est CALCULÉE par le serveur
 * selon le préavis et la période en cours (aperçu affiché avant de
 * confirmer). Une date souhaitée plus tardive est possible ; une date plus
 * précoce n'est possible que par dérogation d'un administrateur, justifiée.
 */
export function TerminateContract({
  contractId, customerName, roles, allowedActions,
}: {
  contractId: string; customerName: string; noticePeriodDays?: number | null; roles: string[]; allowedActions: string[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [initiatedBy, setInitiatedBy] = useState<'LSI' | 'CLIENT'>('LSI');
  const [requested, setRequested] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const isAdmin = roles.includes('MSP_ADMIN');
  const canAct = allowedActions.includes('TERMINATE') && roles.some((r) => ADMIN_OR_AM.includes(r));

  const preview = useQuery({
    queryKey: ['termination-preview', contractId],
    queryFn: () => apiGet<TerminationPreview>(`/v1/contracts/${contractId}/termination-preview`),
    enabled: open && canAct,
  });
  const computed = preview.data?.effectiveDate ?? null;
  const beforeComputed = !!requested && !!computed && requested < computed;

  const m = useMutation({
    mutationFn: () => apiPost<{ status: string; effectiveDate: string; noticeRespected: boolean }>(`/v1/contracts/${contractId}/terminate`, {
      reason: reason.trim(),
      initiatedBy,
      ...(requested ? { effectiveDate: requested } : {}),
      ...(isAdmin && beforeComputed ? { overrideReason: overrideReason.trim() } : {}),
    }),
    onSuccess: (r) => {
      for (const key of [['contract', contractId], ['allowed-actions', contractId], ['lifecycle', contractId], ['deadlines']]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      toast.show(`Résiliation enregistrée : prise d’effet le ${fmt(r.effectiveDate)}.`, 'success');
      setOpen(false);
    },
  });

  if (!canAct) return null;
  const nameOk = confirmName.trim() === customerName.trim();
  const overrideOk = !beforeComputed || (isAdmin && overrideReason.trim().length > 0);
  const ready = reason.trim().length > 0 && nameOk && overrideOk && !m.isPending;

  if (!open) {
    return <Button type="button" variant="danger-ghost" onClick={() => setOpen(true)}>Résilier</Button>;
  }

  return (
    <form className="flex flex-col gap-3 rounded-lg border border-danger/40 p-4" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <p className="text-sm font-button text-danger">Résiliation du contrat</p>

      <section aria-label="Date d’effet calculée" className="rounded border border-line bg-page px-3 py-2 text-sm">
        {preview.isLoading && <p role="status" className="text-ink-muted">Calcul de la date d’effet…</p>}
        {preview.error && <p role="alert" className="text-danger">{errorMessage(preview.error, 'Date d’effet indisponible.')}</p>}
        {preview.data && (
          <>
            <p>Date d’effet calculée (préavis et période en cours) : <strong>{fmt(preview.data.effectiveDate)}</strong></p>
            {preview.data.noticeDeadline && (
              <p className="text-ink-muted">
                Date limite de dénonciation : {fmt(preview.data.noticeDeadline)} · terme de la période en cours : {fmt(preview.data.currentPeriodEnd)}
              </p>
            )}
            {preview.data.deadlineMissed && (
              <p role="alert" className="mt-1 flex items-start gap-2 text-warn">
                <Icon name="alert" className="mt-0.5 h-4 w-4" />
                La date limite de dénonciation est dépassée : le contrat sera reconduit et la résiliation ne prendra effet qu’au terme de la période suivante.
              </p>
            )}
          </>
        )}
      </section>

      <Field label="Motif" htmlFor="term-reason">
        <textarea id="term-reason" className={controlClass} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <Field label="Initié par" htmlFor="term-by">
        <Select id="term-by" value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value as 'LSI' | 'CLIENT')}>
          <option value="LSI">LSI</option>
          <option value="CLIENT">Client</option>
        </Select>
      </Field>
      <Field label="Date d’effet souhaitée (facultatif)" htmlFor="term-date" hint="Vide : la date calculée ci-dessus s’applique.">
        <Input id="term-date" type="date" value={requested} onChange={(e) => setRequested(e.target.value)} />
      </Field>
      {beforeComputed && isAdmin && (
        <Field label="Justification de la dérogation au préavis (obligatoire)" htmlFor="term-override">
          <textarea id="term-override" className={controlClass} rows={2} maxLength={2000} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
        </Field>
      )}
      {beforeComputed && !isAdmin && (
        <p role="alert" className="text-sm text-danger">La date souhaitée précède la date calculée : seul un administrateur peut déroger au préavis.</p>
      )}
      <Field label={`Tapez le nom du client (${customerName}) pour confirmer`} htmlFor="term-confirm">
        <Input id="term-confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
      </Field>
      {m.error && <p role="alert" className="text-sm text-danger">{errorMessage(m.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={!ready}>{m.isPending ? 'Résiliation…' : 'Confirmer la résiliation'}</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button>
      </div>
    </form>
  );
}
