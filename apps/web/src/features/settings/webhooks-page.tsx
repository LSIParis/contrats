import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { canDo } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import type { StatusTone } from '../../ui/theme/status.js';
import { SecretOnceDialog } from './secret-once.js';
import { SettingsNav } from './settings-nav.js';

/**
 * Webhooks sortants (07-api.md §5) : abonnements signés HMAC-SHA256, secret
 * affiché une seule fois (création, rotation), test (`ping`), historique des
 * livraisons et relivraison. Droit : `webhooks.manage` (MSP_ADMIN).
 */
interface Subscription {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  secretHint: string;
  active: boolean;
  consecutiveFailures: number;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
}
interface Delivery {
  id: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD';
  attempt: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseMs: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  event: { id: string; type: string; occurredAt: string; resourceId: string | null };
}
type Outcome = 'DELIVERED' | 'FAILED' | 'DEAD' | 'SKIPPED';

export const EVENT_LABELS: Record<string, string> = {
  'contract.activated': 'Contrat activé',
  'contract.signed': 'Contrat signé',
  'contract.renewal_due': 'Renouvellement à prévoir',
  'contract.renewed': 'Contrat renouvelé',
  'contract.terminated': 'Contrat résilié',
  'pricing.revised': 'Tarification révisée',
  ping: 'Test (ping)',
};
const OUTCOMES: Record<Outcome, string> = {
  DELIVERED: 'livré',
  FAILED: 'échec (nouvelle tentative programmée)',
  DEAD: 'abandonné après la dernière tentative',
  SKIPPED: 'ignoré (abonnement inactif ou livraison déjà traitée)',
};
const DELIVERY_STATUS: Record<Delivery['status'], { label: string; tone: StatusTone }> = {
  PENDING: { label: 'En attente', tone: 'info' },
  DELIVERED: { label: 'Livrée', tone: 'success' },
  FAILED: { label: 'En échec (reprise programmée)', tone: 'warn' },
  DEAD: { label: 'Abandonnée', tone: 'danger' },
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) : '—');

export function WebhooksPage() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (!canDo(me.data, 'webhooks.manage')) return <p role="alert" className="text-danger">Accès réservé aux administrateurs.</p>;
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Administration' }, { label: 'Paramètres', to: '/settings' }, { label: 'Webhooks sortants' }]} />
      <h1>Webhooks sortants</h1>
      <SettingsNav />
      <WebhooksAdmin />
    </div>
  );
}

type Pending = { kind: 'disable' | 'rotate-secret'; s: Subscription } | null;

function WebhooksAdmin() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => apiRequest<{ subscriptions: Subscription[]; eventTypes: string[] }>('GET', '/v1/admin/webhooks'),
  });
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<Subscription | null>(null);
  const [notice, setNotice] = useState<string>();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });

  const act = useMutation({
    mutationFn: (p: NonNullable<Pending>) => apiRequest<Subscription & { secret?: string }>('POST', `/v1/admin/webhooks/${p.s.id}/${p.kind}`),
    onSuccess: (r, p) => {
      setPending(null);
      refresh();
      if (p.kind === 'rotate-secret' && r.secret) setSecret(r.secret);
      else setNotice('Abonnement désactivé : plus aucune livraison.');
    },
  });
  const enable = useMutation({
    mutationFn: (s: Subscription) => apiRequest<Subscription>('POST', `/v1/admin/webhooks/${s.id}/enable`),
    onSuccess: () => { setNotice('Abonnement réactivé (compteur d’échecs remis à zéro).'); refresh(); },
  });
  const test = useMutation({
    mutationFn: (s: Subscription) => apiRequest<{ deliveryId: string; outcome: Outcome }>('POST', `/v1/admin/webhooks/${s.id}/test`),
    onSuccess: (r) => {
      setNotice(`Ping : ${OUTCOMES[r.outcome] ?? r.outcome}.`);
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    },
  });

  const subs = q.data?.subscriptions ?? [];
  const actionError = errorText(test.error) ?? errorText(enable.error);
  return (
    <>
      <RegionCard title="Abonnements" actions={<Button type="button" size="sm" onClick={() => setCreating(true)}>Nouvel abonnement</Button>}>
        <p className="text-13 text-ink-muted">
          Chaque livraison est signée (HMAC-SHA256, horodatage anti-rejeu). Reprises après 1 min, 5 min, 30 min, 2 h et 12 h, puis abandon ;
          l’abonnement est désactivé automatiquement après une série d’abandons consécutifs.
        </p>
        {q.isLoading && <Spinner />}
        <ErrorNote>{errorText(q.error) ?? actionError}</ErrorNote>
        {notice && <p role="status" className="text-13 text-ink">{notice}</p>}
        {q.data && subs.length === 0 && <p className="text-13 text-ink-faint">Aucun abonnement.</p>}
        {subs.length > 0 && (
          <Table
            caption="Abonnements aux webhooks"
            head={<tr><th>Destination</th><th>Événements</th><th>Secret</th><th>Échecs</th><th>État</th><th>Actions</th></tr>}
          >
            {subs.map((s) => (
              <tr key={s.id}>
                <td className="max-w-[280px] break-all">
                  <span className="font-medium">{s.url}</span>
                  {s.description && <span className="block text-xs text-ink-faint">{s.description}</span>}
                </td>
                <td><ul className="flex flex-wrap gap-1">{s.eventTypes.map((e) => <li key={e}><Badge tone="info">{EVENT_LABELS[e] ?? e}</Badge></li>)}</ul></td>
                <td><code className="text-13">…{s.secretHint}</code></td>
                <td className="tabular-nums">{s.consecutiveFailures}</td>
                <td>
                  {s.active ? <Badge tone="success">Actif</Badge> : <Badge tone="muted">Désactivé</Badge>}
                  {!s.active && s.disabledReason && <span className="block text-xs text-ink-faint">{s.disabledReason}</span>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {s.active && (
                      <Button type="button" size="sm" variant="secondary" aria-label={`Tester ${s.url}`} disabled={test.isPending} onClick={() => { setNotice(undefined); test.mutate(s); }}>
                        Tester
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" aria-label={`Livraisons de ${s.url}`} onClick={() => setSelected(selected?.id === s.id ? null : s)}>
                      Livraisons
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`Nouveau secret pour ${s.url}`} onClick={() => { act.reset(); setPending({ kind: 'rotate-secret', s }); }}>
                      Rotation du secret
                    </Button>
                    {s.active ? (
                      <Button type="button" size="sm" variant="danger-ghost" aria-label={`Désactiver ${s.url}`} onClick={() => { act.reset(); setPending({ kind: 'disable', s }); }}>
                        Désactiver
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" aria-label={`Réactiver ${s.url}`} disabled={enable.isPending} onClick={() => enable.mutate(s)}>
                        Réactiver
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </RegionCard>

      {selected && <Deliveries key={selected.id} sub={selected} />}

      <ConfirmDialog
        open={pending?.kind === 'disable'}
        title="Désactiver l’abonnement"
        confirmLabel="Désactiver"
        variant="danger"
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => setPending(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        <p>Plus aucun événement ne sera envoyé à {pending?.s.url}. La réactivation remet le compteur d’échecs à zéro.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'rotate-secret'}
        title="Nouveau secret de signature"
        confirmLabel="Générer un nouveau secret"
        variant="warn"
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => setPending(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        <p>L’ancien secret cesse immédiatement : le destinataire rejettera les livraisons tant qu’il n’aura pas le nouveau.</p>
      </ConfirmDialog>

      {creating && (
        <CreateSubscriptionDialog
          eventTypes={q.data?.eventTypes ?? Object.keys(EVENT_LABELS).filter((k) => k !== 'ping')}
          onClose={() => setCreating(false)}
          onCreated={(s) => { setCreating(false); refresh(); setSecret(s); }}
        />
      )}
      {secret && (
        <SecretOnceDialog title="Secret de signature — affiché une seule fois" label="Secret HMAC" value={secret} doneLabel="J’ai conservé le secret" onClose={() => setSecret(null)}>
          <p>À configurer chez le destinataire pour vérifier l’en-tête de signature de chaque livraison.</p>
        </SecretOnceDialog>
      )}
    </>
  );
}

function CreateSubscriptionDialog({ eventTypes, onClose, onCreated }: { eventTypes: string[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const uid = useId();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<Subscription & { secret: string }>('POST', '/v1/admin/webhooks', body),
    onSuccess: (r) => onCreated(r.secret),
  });
  return (
    <ConfirmDialog
      open
      title="Nouvel abonnement"
      confirmLabel="Créer l’abonnement"
      disabled={!url.trim() || types.length === 0}
      onConfirm={() => m.mutate({ url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}), eventTypes: types })}
      onClose={onClose}
      pending={m.isPending}
      error={errorText(m.error)}
    >
      <Field label="URL de destination (https)" htmlFor={`${uid}-url`} hint="https obligatoire, sans identifiants ; hôtes privés refusés.">
        <Input id={`${uid}-url`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`}>
        <Input id={`${uid}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs+ font-button text-ink-muted">Événements (au moins un)</legend>
        {eventTypes.map((t) => (
          <label key={t} className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes((xs) => (e.target.checked ? [...xs, t] : xs.filter((x) => x !== t)))} />
            {EVENT_LABELS[t] ?? t} <code className="text-xs text-ink-faint">({t})</code>
          </label>
        ))}
      </fieldset>
    </ConfirmDialog>
  );
}

function Deliveries({ sub }: { sub: Subscription }) {
  const uid = useId();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState<string>();
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', '50');
  const q = useQuery({
    queryKey: ['webhook-deliveries', sub.id, status],
    queryFn: () => apiRequest<{ deliveries: Delivery[] }>('GET', `/v1/admin/webhooks/${sub.id}/deliveries?${params.toString()}`),
    placeholderData: (prev) => prev, // le tableau reste en place pendant un changement de filtre
  });
  const redeliver = useMutation({
    mutationFn: (d: Delivery) => apiRequest<{ deliveryId: string; outcome: Outcome }>('POST', `/v1/admin/webhook-deliveries/${d.id}/redeliver`),
    onSuccess: (r) => {
      setNotice(`Relivraison : ${OUTCOMES[r.outcome] ?? r.outcome}.`);
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries', sub.id] });
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const rows = q.data?.deliveries ?? [];
  return (
    <RegionCard title={`Livraisons — ${sub.url}`}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Statut" htmlFor={`${uid}-status`}>
          <Select id={`${uid}-status`} value={status} onChange={(e) => setStatus(e.target.value)} className="w-64">
            <option value="">Tous</option>
            {(Object.keys(DELIVERY_STATUS) as Delivery['status'][]).map((k) => <option key={k} value={k}>{DELIVERY_STATUS[k].label}</option>)}
          </Select>
        </Field>
        <span className="pb-2 text-13 text-ink-faint">50 plus récentes.</span>
      </div>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error) ?? errorText(redeliver.error)}</ErrorNote>
      {notice && <p role="status" className="text-13 text-ink">{notice}</p>}
      {q.data && rows.length === 0 && <p className="text-13 text-ink-faint">Aucune livraison.</p>}
      {rows.length > 0 && (
        <Table
          caption="Livraisons"
          head={<tr><th>Événement</th><th>Créée le</th><th>Statut</th><th>Tentative</th><th>HTTP</th><th>Durée</th><th>Erreur</th><th>Prochaine tentative</th><th>Action</th></tr>}
        >
          {rows.map((d) => {
            const st = DELIVERY_STATUS[d.status] ?? { label: d.status, tone: 'neutral' as const };
            return (
              <tr key={d.id}>
                <td>{EVENT_LABELS[d.event.type] ?? d.event.type}<span className="block text-xs text-ink-faint">{d.event.resourceId ?? ''}</span></td>
                <td>{fmt(d.createdAt)}</td>
                <td><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="tabular-nums">{d.attempt}</td>
                <td className="tabular-nums">{d.responseStatus ?? '—'}</td>
                <td className="tabular-nums">{d.responseMs == null ? '—' : `${d.responseMs} ms`}</td>
                <td className="max-w-[220px] break-words text-13">{d.lastError ?? '—'}</td>
                <td>{d.status === 'DELIVERED' ? fmt(d.deliveredAt) : fmt(d.nextAttemptAt)}</td>
                <td>
                  {d.status !== 'PENDING' && (
                    <Button type="button" size="sm" variant="secondary" disabled={!sub.active || redeliver.isPending} onClick={() => redeliver.mutate(d)}>
                      Relivrer
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </RegionCard>
  );
}
