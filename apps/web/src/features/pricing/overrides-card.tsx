import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { decimalFromInput, formatDecimal, formatDecimalEuros } from '../../lib/money.js';
import { canDo } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { OVERRIDE_STATUS, fmtDay } from './labels.js';
import type { OverrideView, ScheduleView } from './types.js';

/**
 * Dérogations tarifaires (brief §5 mode 3 ; 04 §8, §17.3) : prix bornés dans
 * le temps, motif obligatoire. Au-delà du seuil d'écart du tenant
 * (`pricing.overrideApprovalThresholdPercent`), la dérogation attend la
 * seconde validation d'un administrateur DISTINCT de l'auteur ; elle n'est
 * jamais appliquée en attendant.
 */
type Pending = { kind: 'approve' | 'reject' | 'cancel'; o: OverrideView } | null;

export function OverridesCard({ contractId, schedules, me }: { contractId: string; schedules: ScheduleView[]; me: Me | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = `/v1/contracts/${contractId}/pricing/overrides`;
  const q = useQuery({ queryKey: ['pricing-overrides', contractId], queryFn: () => apiRequest<{ items: OverrideView[] }>('GET', base) });
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [rejectReason, setRejectReason] = useState('');
  const canWrite = canDo(me, 'pricing.write');
  const canApprove = canDo(me, 'pricing.override.approve');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['pricing-overrides', contractId] });
    void qc.invalidateQueries({ queryKey: ['pricing-at', contractId] });
  };

  const decide = useMutation({
    mutationFn: (p: NonNullable<Pending>) =>
      apiRequest<OverrideView>('POST', `${base}/${p.o.id}/${p.kind}`, p.kind === 'reject' ? { reason: rejectReason.trim() } : undefined),
    onSuccess: (o, p) => {
      toast.show(p.kind === 'approve' ? 'Dérogation validée : elle s’applique.' : p.kind === 'reject' ? 'Dérogation refusée.' : 'Dérogation annulée.', 'success');
      setPending(null);
      setRejectReason('');
      refresh();
      return o;
    },
  });

  const open = (p: Pending) => {
    decide.reset();
    setRejectReason('');
    setPending(p);
  };

  const items = q.data?.items ?? [];
  return (
    <RegionCard
      title="Dérogations tarifaires"
      actions={canWrite ? <Button type="button" size="sm" onClick={() => setCreating(true)}>Demander une dérogation</Button> : undefined}
    >
      {q.isLoading ? <Spinner /> : <ErrorNote>{errorText(q.error)}</ErrorNote>}
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucune dérogation.</p>}
      {items.length > 0 && (
        <Table
          caption="Dérogations tarifaires"
          head={<tr><th>Ligne</th><th>Prix dérogé</th><th>Prix calculé</th><th>Écart</th><th>Période</th><th>Motif</th><th>Statut</th><th>Actions</th></tr>}
        >
          {items.map((o) => {
            const st = OVERRIDE_STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
            const mine = o.authorUserId === me?.userId;
            const approvable = o.status === 'PENDING_APPROVAL' || (o.status === 'ACTIVE' && o.approvedByUserId === null && o.requiresSecondApproval);
            return (
              <tr key={o.id}>
                <td>{o.lineKey}</td>
                <td className="tabular-nums">{formatDecimalEuros(o.unitPrice)}</td>
                <td className="tabular-nums">{formatDecimalEuros(o.computedUnitPrice)}</td>
                <td className="tabular-nums">{o.gapPercent == null ? '—' : `${formatDecimal(o.gapPercent, { minFraction: 0 })} %`}</td>
                <td>{fmtDay(o.validFrom)} → {fmtDay(o.validTo)}</td>
                <td className="max-w-[260px]">
                  {o.reason}
                  {o.rejectionReason && <span className="block text-xs text-danger">Refus : {o.rejectionReason}</span>}
                </td>
                <td>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {o.status === 'ACTIVE' && o.approvedByUserId && <span className="block text-xs text-ink-faint">double validation</span>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {canApprove && approvable && !mine && (
                      <>
                        <Button type="button" size="sm" onClick={() => open({ kind: 'approve', o })}>Valider</Button>
                        {o.status === 'PENDING_APPROVAL' && (
                          <Button type="button" size="sm" variant="danger-ghost" onClick={() => open({ kind: 'reject', o })}>Refuser</Button>
                        )}
                      </>
                    )}
                    {canApprove && approvable && mine && (
                      <span className="text-xs text-ink-faint">Votre demande : validation par un autre administrateur.</span>
                    )}
                    {canWrite && (o.status === 'PENDING_APPROVAL' || o.status === 'ACTIVE') && (
                      <Button type="button" size="sm" variant="ghost" aria-label="Annuler la dérogation" onClick={() => open({ kind: 'cancel', o })}>
                        Annuler
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <ConfirmDialog
        open={pending?.kind === 'approve'}
        title="Valider la dérogation"
        confirmLabel="Valider la dérogation"
        onConfirm={() => pending && decide.mutate(pending)}
        onClose={() => setPending(null)}
        pending={decide.isPending}
        error={errorText(decide.error)}
      >
        {pending && (
          <p>
            Seconde validation de la dérogation sur « {pending.o.lineKey} » : {formatDecimalEuros(pending.o.unitPrice)} au lieu de{' '}
            {formatDecimalEuros(pending.o.computedUnitPrice)}, du {fmtDay(pending.o.validFrom)} au {fmtDay(pending.o.validTo)}. Motif : « {pending.o.reason} ».
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'reject'}
        title="Refuser la dérogation"
        confirmLabel="Refuser la dérogation"
        variant="danger"
        disabled={!rejectReason.trim()}
        onConfirm={() => pending && decide.mutate(pending)}
        onClose={() => setPending(null)}
        pending={decide.isPending}
        error={errorText(decide.error)}
      >
        <Field label="Motif du refus (obligatoire)" htmlFor="override-reject-reason">
          <textarea id="override-reject-reason" rows={3} className={controlClass} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'cancel'}
        title="Annuler la dérogation"
        confirmLabel="Annuler la dérogation"
        variant="danger"
        onConfirm={() => pending && decide.mutate(pending)}
        onClose={() => setPending(null)}
        pending={decide.isPending}
        error={errorText(decide.error)}
      >
        <p>La dérogation cesse de s’appliquer ; le prix calculé reprend. Cette action est définitive.</p>
      </ConfirmDialog>

      {creating && (
        <CreateOverrideDialog
          contractId={contractId}
          schedules={schedules}
          onClose={() => setCreating(false)}
          onCreated={(o) => {
            setCreating(false);
            toast.show(
              o.status === 'PENDING_APPROVAL'
                ? `Dérogation soumise à seconde validation (écart ${o.gapPercent == null ? 'non calculable' : `${formatDecimal(o.gapPercent, { minFraction: 0 })} %`}).`
                : 'Dérogation active.',
              o.status === 'PENDING_APPROVAL' ? 'warn' : 'success',
            );
            refresh();
          }}
        />
      )}
    </RegionCard>
  );
}

function CreateOverrideDialog({
  contractId, schedules, onClose, onCreated,
}: {
  contractId: string;
  schedules: ScheduleView[];
  onClose: () => void;
  onCreated: (o: OverrideView) => void;
}) {
  const uid = useId();
  // Lignes connues des versions engagées (clés stables d'une version à l'autre).
  const keys = new Map<string, string>();
  for (const s of schedules.filter((x) => x.status !== 'DRAFT')) {
    for (const l of s.lines) if (l.kind !== 'DISCOUNT') keys.set(l.lineKey, l.label);
  }
  const [lineKey, setLineKey] = useState(keys.keys().next().value ?? '');
  const [price, setPrice] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<OverrideView>('POST', `/v1/contracts/${contractId}/pricing/overrides`, body),
    onSuccess: onCreated,
  });
  const ready = Boolean(lineKey.trim() && price.trim() && validFrom && validTo && reason.trim());

  function submit() {
    const unitPrice = decimalFromInput(price);
    if (!unitPrice) {
      setFormError('Prix invalide (nombre attendu, ex. 33,50).');
      return;
    }
    if (validTo < validFrom) {
      setFormError('La fin de période précède son début.');
      return;
    }
    setFormError(undefined);
    m.mutate({ lineKey: lineKey.trim(), unitPrice, validFrom, validTo, reason: reason.trim() });
  }

  return (
    <ConfirmDialog
      open
      title="Demander une dérogation"
      confirmLabel="Envoyer la demande"
      disabled={!ready}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <p className="text-13 text-ink-muted">
        Prix unitaire HT imposé sur une période bornée. Au-delà du seuil d’écart du tenant avec le prix calculé, un administrateur
        (autre que vous) doit la valider ; elle ne s’applique pas en attendant.
      </p>
      <Field label="Ligne" htmlFor={`${uid}-line`}>
        {keys.size > 0 ? (
          <Select id={`${uid}-line`} value={lineKey} onChange={(e) => setLineKey(e.target.value)}>
            {[...keys].map(([k, label]) => <option key={k} value={k}>{label} ({k})</option>)}
          </Select>
        ) : (
          <Input id={`${uid}-line`} value={lineKey} onChange={(e) => setLineKey(e.target.value)} />
        )}
      </Field>
      <Field label="Prix unitaire HT dérogatoire (€)" htmlFor={`${uid}-price`}>
        <Input id={`${uid}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Du" htmlFor={`${uid}-from`}>
          <Input id={`${uid}-from`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Au (inclus)" htmlFor={`${uid}-to`}>
          <Input id={`${uid}-to`} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Motif (obligatoire)" htmlFor={`${uid}-reason`}>
        <textarea id={`${uid}-reason`} rows={3} className={controlClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
