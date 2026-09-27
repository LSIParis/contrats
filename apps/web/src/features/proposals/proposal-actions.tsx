import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows, type UiAction } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Button, type ButtonVariant } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { useToast } from '../../ui/toast.js';
import { proposalsApi, type ProposalDetail } from './proposal-api.js';

/**
 * Transitions de la proposition : UNIQUEMENT celles que l'API déclare
 * possibles (`allowedEvents`, machine du domaine, gardes comprises) ET que le
 * rôle autorise (`/v1/auth/me`). Les événements du client ou du système
 * (consultation, acceptation, expiration, signature…) ne sont jamais proposés.
 */
interface ActionDef {
  event: string;
  label: string;
  perm: UiAction;
  path: string;
  variant?: ButtonVariant;
  /** Confirmation : titre, bouton, texte. Sans confirmation, l'action part au clic. */
  dialog?: { title: string; confirm: string; text: string; reason?: boolean; date?: boolean };
}

export const PROPOSAL_ACTIONS: ActionDef[] = [
  { event: 'SUBMIT_FOR_REVIEW', label: 'Soumettre en revue interne', perm: 'proposals.write', path: 'submit-review', variant: 'secondary' },
  {
    event: 'APPROVE_REVIEW', label: 'Valider la revue', perm: 'proposals.review', path: 'approve-review',
    dialog: { title: 'Valider la revue interne', confirm: 'Valider', text: 'La proposition passera « Prête ». Le valideur doit être distinct de l’auteur de la soumission.' },
  },
  {
    event: 'REJECT_REVIEW', label: 'Demander des modifications', perm: 'proposals.review', path: 'reject-review', variant: 'warn',
    dialog: { title: 'Demander des modifications', confirm: 'Renvoyer en brouillon', text: 'La proposition revient en brouillon ; le motif est tracé.', reason: true },
  },
  { event: 'MARK_READY', label: 'Marquer prête', perm: 'proposals.write', path: 'mark-ready' },
  {
    event: 'SEND', label: 'Envoyer au client', perm: 'proposals.send', path: 'send',
    dialog: {
      title: 'Envoyer la proposition', confirm: 'Envoyer',
      text: 'La version est figée (empreinte), un lien personnel est créé et envoyé par e-mail à chaque destinataire, et les relances sont planifiées.',
    },
  },
  { event: 'CLOSE_DISCUSSION', label: 'Clore la discussion', perm: 'proposals.write', path: 'close-discussion', variant: 'secondary' },
  // START_SIGNATURE et CONVERT (relances techniques) : onglet « Signature et contrat », à côté de l'erreur.
  {
    event: 'REVISE', label: 'Réviser (nouvelle version)', perm: 'proposals.write', path: 'revise', variant: 'secondary',
    dialog: {
      title: 'Créer une nouvelle version', confirm: 'Réviser',
      text: 'Une nouvelle version repart en brouillon. Si la proposition a été envoyée, l’ancienne version est remplacée, ses liens révoqués et les destinataires prévenus.',
      reason: true,
    },
  },
  {
    event: 'WITHDRAW', label: 'Retirer', perm: 'proposals.write', path: 'withdraw', variant: 'danger-ghost',
    dialog: { title: 'Retirer la proposition', confirm: 'Retirer', text: 'Retrait définitif : les liens ne permettront plus d’accepter. Le motif est obligatoire.', reason: true },
  },
  {
    event: 'REACTIVATE', label: 'Réactiver', perm: 'proposals.send', path: 'reactivate',
    dialog: { title: 'Réactiver la proposition', confirm: 'Réactiver', text: 'La proposition expirée repasse « Prête » avec une nouvelle échéance ; le motif est tracé.', reason: true, date: true },
  },
];

const isDetail = (r: unknown): r is ProposalDetail => !!r && typeof r === 'object' && 'proposal' in r && 'version' in r;

export function ProposalActions({
  detail, me, onDetail, onRefresh,
}: {
  detail: ProposalDetail;
  me: Me | undefined;
  onDetail: (d: ProposalDetail) => void;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<ActionDef | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const pid = detail.proposal.id;

  const run = useMutation({
    mutationFn: (a: ActionDef) => {
      const body = a.dialog?.date ? { reason: reason.trim(), expiresOn: date } : a.dialog?.reason ? { reason: reason.trim() } : {};
      return proposalsApi.action(pid, a.path, body) as Promise<unknown>;
    },
    onSuccess: (r, a) => {
      if (isDetail(r)) onDetail(r);
      else onRefresh();
      toast.show(`${a.label} : effectué.`, 'success');
      setOpen(null);
    },
  });

  const visible = PROPOSAL_ACTIONS.filter((a) => detail.allowedEvents.includes(a.event) && allows(me, a.perm));
  const start = (a: ActionDef) => {
    run.reset();
    setReason('');
    setDate('');
    if (a.dialog) setOpen(a);
    else run.mutate(a);
  };
  const needsReason = !!open?.dialog?.reason && reason.trim().length < 3;
  const needsDate = !!open?.dialog?.date && !/^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <>
      <div role="group" aria-label="Actions sur la proposition" className="flex flex-wrap gap-2">
        {visible.map((a) => (
          <Button key={a.event} variant={a.variant ?? 'primary'} size="sm" disabled={run.isPending} onClick={() => start(a)}>
            {a.label}
          </Button>
        ))}
      </div>
      {!open && run.error && <p role="alert" className="mt-2 text-13 text-danger">{errorMessage(run.error)}</p>}
      <ConfirmDialog
        open={!!open}
        title={open?.dialog?.title ?? ''}
        confirmLabel={open?.dialog?.confirm ?? ''}
        variant={open?.variant === 'danger-ghost' ? 'danger' : 'primary'}
        onClose={() => setOpen(null)}
        onConfirm={() => open && run.mutate(open)}
        pending={run.isPending}
        disabled={needsReason || needsDate}
        error={errorMessage(run.error)}
      >
        <p>{open?.dialog?.text}</p>
        {open?.dialog?.date && (
          <Field label="Nouvelle échéance" htmlFor="action-date">
            <Input id="action-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
        {open?.dialog?.reason && (
          <Field label="Motif" htmlFor="action-motif" hint="3 caractères au moins ; conservé dans l’historique.">
            <textarea id="action-motif" className="min-h-[80px] w-full rounded border border-line-strong px-2.5 py-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
}
