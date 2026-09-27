import { useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { useToast } from '../../ui/toast.js';
import { ReasonDialog } from '../lifecycle/reason-dialog.js';
import { useContractAction } from '../lifecycle/use-contract-action.js';

type Dialog = null | 'send' | 'negotiate' | 'reopen' | 'accept';

/**
 * Présentation au client, négociation, acceptation (02-cycle-de-vie §2-§4).
 * Chaque bouton n'apparaît que si la machine à états l'autorise
 * (allowed-actions) ET si le rôle le permet (contracts.negotiate).
 */
export function NegotiationActions({ contractId, currentVersionId, allowedActions, me }: {
  contractId: string;
  currentVersionId: string | null;
  allowedActions: string[];
  me: Me | undefined;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const send = useContractAction(contractId, 'send-to-client');
  const negotiate = useContractAction(contractId, 'negotiate');
  const reopen = useContractAction(contractId, 'reopen-negotiation');
  const accept = useContractAction(contractId, 'acceptance');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [evidence, setEvidence] = useState('');

  if (!allows(me, 'contracts.negotiate')) return null;
  const can = (a: string) => allowedActions.includes(a);
  const any = can('SEND_TO_CLIENT') || can('OPEN_NEGOTIATION') || can('REOPEN_NEGOTIATION') || can('CLIENT_ACCEPT');
  if (!any) return null;
  const close = () => { setDialog(null); send.reset(); negotiate.reset(); reopen.reset(); accept.reset(); };
  const done = (msg: string) => () => { toast.show(msg, 'success'); setDialog(null); };

  const submitAccept = (e: FormEvent) => {
    e.preventDefault();
    if (!currentVersionId) return;
    accept.mutate(
      { versionId: currentVersionId, acceptedByName: name.trim(), acceptedByEmail: email.trim(), evidenceNote: evidence.trim() },
      { onSuccess: done('Acceptation du client enregistrée.') },
    );
  };
  const acceptReady = name.trim() && /.+@.+\..+/.test(email.trim()) && evidence.trim().length >= 5;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {can('SEND_TO_CLIENT') && <Button type="button" onClick={() => setDialog('send')}>Envoyer au client</Button>}
        {can('OPEN_NEGOTIATION') && <Button type="button" variant="warn" onClick={() => setDialog('negotiate')}>Ouvrir une négociation</Button>}
        {can('REOPEN_NEGOTIATION') && <Button type="button" variant="warn" onClick={() => setDialog('reopen')}>Rouvrir la négociation</Button>}
        {can('CLIENT_ACCEPT') && <Button type="button" variant="secondary" onClick={() => setDialog('accept')}>Enregistrer une acceptation</Button>}
      </div>

      <Modal open={dialog === 'send'} onClose={close} title="Envoyer la proposition au client" footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
          <Button type="button" disabled={send.isPending} onClick={() => send.mutate({}, { onSuccess: done('Proposition envoyée au client.') })}>
            {send.isPending ? 'Envoi…' : 'Confirmer l’envoi'}
          </Button>
        </>
      }>
        <p className="text-sm">
          La version validée sera présentée au client dans son espace : il pourra la lire, l’accepter ou demander des modifications.
        </p>
        {send.error ? <p role="alert" className="mt-2 text-sm text-danger">{errorMessage(send.error)}</p> : null}
      </Modal>

      <ReasonDialog
        open={dialog === 'negotiate'} title="Ouvrir une négociation" label="Modifications demandées par le client"
        intro={<p>Le contrat passe en négociation. Toute nouvelle version devra être revalidée avant d’être renvoyée au client.</p>}
        confirmLabel="Ouvrir la négociation" pending={negotiate.isPending} error={negotiate.error} onClose={close}
        onConfirm={(reason) => negotiate.mutate({ reason }, { onSuccess: done('Négociation ouverte.') })}
      />
      <ReasonDialog
        open={dialog === 'reopen'} title="Rouvrir la négociation" label="Motif de la reprise"
        intro={<p>Après un refus ou une expiration de la signature, la proposition revient en négociation.</p>}
        confirmLabel="Rouvrir" pending={reopen.isPending} error={reopen.error} onClose={close}
        onConfirm={(reason) => reopen.mutate({ reason }, { onSuccess: done('Négociation rouverte.') })}
      />

      <Modal open={dialog === 'accept'} onClose={close} title="Enregistrer une acceptation reçue hors application">
        <form onSubmit={submitAccept} className="flex flex-col gap-3 text-sm">
          <p className="text-ink-muted">
            L’acceptation porte sur la version présentée au client ; elle est distincte de la signature. Une pièce justificative est obligatoire.
          </p>
          <Field label="Nom de la personne qui accepte" htmlFor="acc-name">
            <Input id="acc-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="E-mail" htmlFor="acc-email">
            <Input id="acc-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Pièce justificative" htmlFor="acc-evidence" hint="Ex. « e-mail du 12/09 de M. Martin, bon pour accord » (5 caractères au moins).">
            <textarea id="acc-evidence" rows={3} maxLength={2000} className={controlClass} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </Field>
          {!currentVersionId && <p className="text-danger">Aucune version à accepter.</p>}
          {accept.error ? <p role="alert" className="text-danger">{errorMessage(accept.error)}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={!acceptReady || accept.isPending || !currentVersionId}>
              {accept.isPending ? 'Enregistrement…' : 'Enregistrer l’acceptation'}
            </Button>
            <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
