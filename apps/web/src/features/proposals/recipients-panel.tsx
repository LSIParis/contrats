import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { useToast } from '../../ui/toast.js';
import { proposalsApi, type ProposalDetail, type RecipientRole, type Tracking } from './proposal-api.js';
import {
  DELIVERY_KIND_LABELS, FOLLOW_UP_KIND_LABELS, FOLLOW_UP_STATUS_LABELS, formatDateTime, formatDay, label, RECIPIENT_ROLE_LABELS,
} from './proposal-labels.js';

interface Contact { id: string; firstName: string; lastName: string; email: string; jobTitle: string | null; isSignatory: boolean }

const PRE_SEND = ['DRAFT', 'READY', 'IN_INTERNAL_REVIEW'];
const LIVE = ['SENT', 'VIEWED', 'IN_DISCUSSION'];

/**
 * Destinataires (décideur, signataires, lecteurs ; ordre de signature) et
 * envoi : un lien personnel par destinataire, renvoi en un clic (nouveau
 * lien, l'ancien est révoqué), historique des envois et relances planifiées.
 */
export function RecipientsPanel({ detail, me, onDetail }: { detail: ProposalDetail; me: Me | undefined; onDetail: (d: ProposalDetail) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const p = detail.proposal;
  const canEdit = allows(me, 'proposals.write') && PRE_SEND.includes(p.status);
  const canResend = allows(me, 'proposals.send') && LIVE.includes(p.status);
  const tracking = useQuery({ queryKey: ['proposal-tracking', p.id], queryFn: () => proposalsApi.tracking(p.id), enabled: !!p.sentAt || !PRE_SEND.includes(p.status) });

  const remove = useMutation({
    mutationFn: (rid: string) => proposalsApi.removeRecipient(p.id, rid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['proposal', p.id] }),
  });
  const resend = useMutation({
    mutationFn: (rid?: string) => proposalsApi.resend(p.id, rid),
    onSuccess: (d) => {
      onDetail(d);
      toast.show('Renvoyé : un nouveau lien personnel a été envoyé, l’ancien est révoqué.', 'success');
    },
  });
  const followUps = useMutation({
    mutationFn: (enabled: boolean) => proposalsApi.update(p.id, { followUpsEnabled: enabled }),
    onSuccess: onDetail,
  });

  const lastDelivery = (rid: string) => (tracking.data?.deliveries ?? []).filter((d) => d.recipientId === rid).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Destinataires" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-15 font-title text-ink">Destinataires</h2>
          {p.expiresAt ? <span className="text-13 text-ink-muted">Lien valable jusqu’au {formatDay(p.expiresAt)}</span> : <span className="text-13 text-ink-muted">Validité : {p.fixedExpiryDate ? `jusqu’au ${formatDay(p.fixedExpiryDate)}` : `${p.validityDays} jours après l’envoi`}</span>}
        </div>
        <ErrorNote>{errorMessage(remove.error) ?? errorMessage(resend.error) ?? errorMessage(followUps.error)}</ErrorNote>
        {detail.recipients.length === 0 ? (
          <p className="text-13 text-ink-muted">Aucun destinataire : ajoutez au moins un signataire (ou un décideur pour l’acceptation par clic).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Destinataires de la proposition</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs+ text-ink-muted">
                  <th scope="col" className="py-2 pr-3 font-button">Nom</th><th scope="col" className="py-2 pr-3 font-button">E-mail</th>
                  <th scope="col" className="py-2 pr-3 font-button">Rôle</th><th scope="col" className="py-2 pr-3 font-button">Ordre</th>
                  <th scope="col" className="py-2 pr-3 font-button">Dernier envoi</th><th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {detail.recipients.map((r) => {
                  const d = lastDelivery(r.id);
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-3">{r.fullName}{r.jobTitle && <span className="text-ink-faint"> — {r.jobTitle}</span>}</td>
                      <td className="py-2 pr-3">{r.email}</td>
                      <td className="py-2 pr-3"><Badge tone={r.role === 'SIGNER' ? 'info' : 'neutral'}>{RECIPIENT_ROLE_LABELS[r.role] ?? r.role}</Badge></td>
                      <td className="py-2 pr-3 tabular-nums">{r.signingOrder + 1}</td>
                      <td className="py-2 pr-3 text-13">
                        {d ? (
                          <span className="flex flex-col">
                            <span>{label(DELIVERY_KIND_LABELS, d.kind)} — {formatDateTime(d.sentAt)}</span>
                            {d.error ? <span className="text-danger">Échec : {d.error}</span> : <span className="text-success">Remis au serveur d’envoi</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="py-2 text-right">
                        {canEdit && <Button size="sm" variant="danger-ghost" aria-label={`Retirer ${r.fullName}`} disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>Retirer</Button>}
                        {canResend && <Button size="sm" variant="secondary" aria-label={`Renvoyer à ${r.fullName}`} disabled={resend.isPending} onClick={() => resend.mutate(r.id)}>Renvoyer</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canResend && detail.recipients.length > 1 && (
          <div><Button size="sm" variant="secondary" disabled={resend.isPending} onClick={() => resend.mutate(undefined)}>Renvoyer à tous</Button></div>
        )}
        {canEdit && <AddRecipient detail={detail} onDetail={onDetail} />}
      </section>

      {(p.sentAt || !PRE_SEND.includes(p.status)) && (
        <FollowUps detail={detail} tracking={tracking.data} canEdit={allows(me, 'proposals.write')} pending={followUps.isPending} onToggle={(v) => followUps.mutate(v)} />
      )}

      {tracking.data && tracking.data.deliveries.length > 0 && (
        <section aria-label="Historique des envois" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
          <h2 className="text-15 font-title text-ink">Historique des envois</h2>
          <ul className="flex flex-col gap-1 text-13">
            {tracking.data.deliveries.map((d) => (
              <li key={d.id}>
                {formatDateTime(d.sentAt)} — {label(DELIVERY_KIND_LABELS, d.kind)} à {d.recipient?.fullName ?? d.recipientId}
                {d.error ? <span className="text-danger"> (échec : {d.error})</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FollowUps({ detail, tracking, canEdit, pending, onToggle }: { detail: ProposalDetail; tracking: Tracking | undefined; canEdit: boolean; pending: boolean; onToggle: (v: boolean) => void }) {
  const cfg = detail.proposal.followUpConfig;
  return (
    <section aria-label="Relances automatiques" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-15 font-title text-ink">Relances automatiques</h2>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={detail.proposal.followUpsEnabled} disabled={!canEdit || pending} onChange={(e) => onToggle(e.target.checked)} />
        Relances automatiques activées
      </label>
      {cfg && <p className="text-13 text-ink-muted">J+{cfg.noOpenAfterDays} sans ouverture, J+{cfg.noDecisionAfterDays} sans décision, J-{cfg.beforeExpiryDays} avant l’échéance ; suspendues dès que le client répond, 48 h minimum entre deux relances.</p>}
      {(tracking?.followUps.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 text-13">
          {tracking!.followUps.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2">
              <span>{label(FOLLOW_UP_KIND_LABELS, f.kind)}</span>
              <span className="text-ink-muted">— {formatDateTime(f.dueAt)}</span>
              <Badge tone={f.status === 'PLANNED' ? 'info' : f.status === 'SENT' ? 'success' : 'muted'}>{label(FOLLOW_UP_STATUS_LABELS, f.status)}</Badge>
              {f.skipReason && <span className="text-ink-faint">({f.skipReason})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddRecipient({ detail, onDetail }: { detail: ProposalDetail; onDetail: (d: ProposalDetail) => void }) {
  const p = detail.proposal;
  const contacts = useQuery({ queryKey: ['customer', p.customerId], queryFn: () => apiGet<{ contacts: Contact[] }>(`/v1/customers/${encodeURIComponent(p.customerId)}`) });
  const blank = { contactId: '', fullName: '', email: '', jobTitle: '', role: 'SIGNER' as RecipientRole };
  const [f, setF] = useState(blank);
  const add = useMutation({
    mutationFn: () => proposalsApi.addRecipient(p.id, {
      contactId: f.contactId || null, fullName: f.fullName.trim(), email: f.email.trim(),
      jobTitle: f.jobTitle.trim() || null, role: f.role, signingOrder: detail.recipients.length,
    }),
    onSuccess: (d) => {
      onDetail(d);
      setF(blank);
    },
  });
  const pick = (id: string) => {
    const c = contacts.data?.contacts.find((x) => x.id === id);
    if (!c) return setF({ ...blank });
    setF({ contactId: c.id, fullName: `${c.firstName} ${c.lastName}`, email: c.email, jobTitle: c.jobTitle ?? '', role: c.isSignatory ? 'SIGNER' : 'DECISION_MAKER' });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.fullName.trim() && f.email.trim()) add.mutate();
  };
  const input = (id: string, lbl: string, key: 'fullName' | 'email' | 'jobTitle', type = 'text') => (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{lbl}</label>
      <Input id={id} type={type} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </div>
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-line pt-3">
      <p className="text-13 font-button text-ink">Ajouter un destinataire</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="dest-contact" className="text-xs+ font-button text-ink-muted">Contact du client</label>
          <Select id="dest-contact" value={f.contactId} onChange={(e) => pick(e.target.value)}>
            <option value="">Saisie libre</option>
            {(contacts.data?.contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName} — {c.email}</option>)}
          </Select>
        </div>
        {input('dest-nom', 'Nom complet', 'fullName')}
        {input('dest-email', 'E-mail', 'email', 'email')}
        {input('dest-fonction', 'Fonction', 'jobTitle')}
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="dest-role" className="text-xs+ font-button text-ink-muted">Rôle</label>
          <Select id="dest-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as RecipientRole })}>
            <option value="SIGNER">Signataire</option>
            <option value="DECISION_MAKER">Décideur</option>
            <option value="READER">Lecteur</option>
          </Select>
        </div>
      </div>
      <ErrorNote>{errorMessage(add.error)}</ErrorNote>
      <div><Button type="submit" size="sm" disabled={add.isPending || !f.fullName.trim() || !f.email.trim()}>Ajouter le destinataire</Button></div>
    </form>
  );
}
