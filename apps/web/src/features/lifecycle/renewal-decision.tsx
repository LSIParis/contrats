import { useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { Icon } from '../../ui/icons.js';
import { useToast } from '../../ui/toast.js';
import { ReasonDialog } from './reason-dialog.js';
import { useContractAction } from './use-contract-action.js';

const fmt = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');

/**
 * Contrat « À renouveler » (02-cycle-de-vie §5.1) : décision HUMAINE —
 * renouveler pour une nouvelle période (durée de reconduction par défaut) ou
 * ne pas renouveler (motif obligatoire). Rien n'est reconduit par un job.
 */
export function RenewalDecision({ contractId, status, endDate, renewalPeriodMonths, allowedActions, me }: {
  contractId: string;
  status: string;
  endDate: string | null;
  renewalPeriodMonths: number | null | undefined;
  allowedActions: string[];
  me: Me | undefined;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'renew' | 'close'>(null);
  const [months, setMonths] = useState('');
  const renew = useContractAction<{ status: string; endDate: string }>(contractId, 'renewal/renew');
  const close = useContractAction(contractId, 'renewal/close');

  if (!allows(me, 'contracts.lifecycle')) return null;
  const canRenew = allowedActions.includes('RENEW_PERIOD');
  const canClose = allowedActions.includes('CLOSE_RENEWAL');
  if (!canRenew && !canClose) return null;

  const monthsOk = !months.trim() || (/^\d+$/.test(months.trim()) && Number(months) >= 1 && Number(months) <= 120);
  const needMonths = !renewalPeriodMonths && !months.trim();
  const submitRenew = (e: FormEvent) => {
    e.preventDefault();
    if (!monthsOk || needMonths) return;
    renew.mutate(months.trim() ? { months: Number(months) } : {}, {
      onSuccess: (r) => { toast.show(`Contrat renouvelé jusqu’au ${fmt(r.endDate)}.`, 'success'); setDialog(null); },
    });
  };
  const dismiss = () => { setDialog(null); renew.reset(); close.reset(); };

  return (
    <div className="flex flex-col gap-2">
      {status === 'RENEWAL_DUE' && (
        <p className="flex items-center gap-2 rounded border border-warn bg-warn-bg px-3 py-2 text-sm text-warn">
          <Icon name="refresh" />
          Renouvellement à décider : le terme de la période en cours est le {fmt(endDate)}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canRenew && <Button type="button" onClick={() => { setMonths(''); setDialog('renew'); }}>Renouveler</Button>}
        {canClose && <Button type="button" variant="secondary" onClick={() => setDialog('close')}>Ne pas renouveler</Button>}
      </div>

      <Modal open={dialog === 'renew'} onClose={dismiss} title="Renouveler pour une nouvelle période">
        <form onSubmit={submitRenew} className="flex flex-col gap-3 text-sm">
          <p className="text-ink-muted">La nouvelle période prolonge le terme actuel ({fmt(endDate)}) et est tracée dans l’historique des périodes.</p>
          <Field label="Durée de la nouvelle période (mois)" htmlFor="renew-months"
            hint={renewalPeriodMonths ? `Vide : durée de reconduction du contrat (${renewalPeriodMonths} mois).` : 'Aucune durée de reconduction n’est définie sur le contrat : précisez-la.'}
            error={monthsOk ? undefined : 'Entre 1 et 120 mois.'}>
            <Input id="renew-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          {renew.error ? <p role="alert" className="text-danger">{errorMessage(renew.error)}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={renew.isPending || !monthsOk || needMonths}>{renew.isPending ? 'Renouvellement…' : 'Confirmer le renouvellement'}</Button>
            <Button type="button" variant="secondary" onClick={dismiss}>Annuler</Button>
          </div>
        </form>
      </Modal>

      <ReasonDialog
        open={dialog === 'close'} title="Ne pas renouveler" label="Motif du non-renouvellement"
        intro={<p>Le contrat reste actif jusqu’à son terme, puis expire.</p>}
        confirmLabel="Confirmer le non-renouvellement" variant="danger" pending={close.isPending} error={close.error} onClose={dismiss}
        onConfirm={(reason) => close.mutate({ reason }, { onSuccess: () => { toast.show('Non-renouvellement enregistré.', 'success'); setDialog(null); } })}
      />
    </div>
  );
}
