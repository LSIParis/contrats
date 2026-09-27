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
import { Icon } from '../../ui/icons.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { SecretOnceDialog } from './secret-once.js';
import { SettingsNav } from './settings-nav.js';

/**
 * Clients de l'API publique `/api/v1` (07-api.md §2, 09-exploitation.md §16) :
 * une clé `ctr_<préfixe>_<secret>` par application consommatrice, scopes fins,
 * débit par minute. La clé n'est montrée qu'à la création et à la rotation.
 * Droit : `apiClients.manage` (MSP_ADMIN).
 */
interface ApiClient {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  active: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
type WithKey = ApiClient & { apiKey: string };

/** Scopes de `public-api/api-key.ts` (API_SCOPES), avec leur portée (07-api.md §2). */
export const API_SCOPES: Array<[scope: string, description: string]> = [
  ['contracts:read', 'Contrats d’un client et détail d’un contrat'],
  ['contracts:dates:read', 'Dates clés d’un contrat et échéances à venir'],
  ['pricing:read', 'Barème d’un contrat à une date (avec trace)'],
  ['pricing:quote', 'Calcul d’un prix (devis)'],
  ['webhooks:manage', 'Abonnements aux webhooks sortants'],
];

const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais');

type Pending = { kind: 'rotate' | 'revoke'; c: ApiClient } | null;

export function ApiClientsPage() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (!canDo(me.data, 'apiClients.manage')) return <p role="alert" className="text-danger">Accès réservé aux administrateurs.</p>;
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Administration' }, { label: 'Paramètres', to: '/settings' }, { label: 'API publique' }]} />
      <h1>API publique</h1>
      <SettingsNav />
      <ApiClientsCard />
    </div>
  );
}

function ApiClientsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['api-clients'], queryFn: () => apiRequest<ApiClient[]>('GET', '/v1/admin/api-clients') });
  const flags = useQuery({
    queryKey: ['feature-flags'],
    queryFn: () => apiRequest<{ flags: Record<string, boolean> }>('GET', '/v1/feature-flags'),
  });
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const act = useMutation({
    mutationFn: (p: NonNullable<Pending>) => apiRequest<WithKey | ApiClient>('POST', `/v1/admin/api-clients/${p.c.id}/${p.kind}`),
    onSuccess: (r, p) => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['api-clients'] });
      if (p.kind === 'rotate' && 'apiKey' in r) setSecret({ name: r.name, key: r.apiKey });
      else toast.show(`Client « ${p.c.name} » révoqué.`, 'success');
    },
  });
  const open = (p: Pending) => { act.reset(); setPending(p); };
  const items = q.data ?? [];
  const apiOff = flags.data && flags.data.flags['contrats.api.enabled'] === false;

  return (
    <RegionCard title="Clients de l’API" actions={<Button type="button" size="sm" onClick={() => setCreating(true)}>Nouveau client d’API</Button>}>
      <p className="flex flex-wrap items-center gap-2 text-13 text-ink-muted">
        <Icon name="key" />
        Une clé par application consommatrice, avec les seuls scopes nécessaires. Rotation annuelle, révocation au moindre doute.
        <a href="/api/v1/docs" target="_blank" rel="noopener" className="text-primary hover:underline">Documentation de l’API (OpenAPI 3.1)</a>
      </p>
      {apiOff && (
        <p className="flex items-center gap-2 rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
          <Icon name="alert" />
          L’API publique est désactivée pour ce tenant (drapeau contrats.api.enabled) : les clés sont refusées (403 API_DISABLED) tant qu’il n’est pas activé dans « Général et IA ».
        </p>
      )}
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucun client d’API.</p>}
      {items.length > 0 && (
        <Table
          caption="Clients de l’API publique"
          head={<tr><th>Nom</th><th>Clé</th><th>Scopes</th><th>Débit</th><th>Dernier usage</th><th>État</th><th>Actions</th></tr>}
        >
          {items.map((c) => (
            <tr key={c.id}>
              <td className="font-medium">{c.name}{c.description && <span className="block text-xs font-normal text-ink-faint">{c.description}</span>}</td>
              <td><code className="text-13">{`ctr_${c.keyPrefix}_…`}</code></td>
              <td><ul className="flex flex-wrap gap-1">{c.scopes.map((s) => <li key={s}><Badge tone="info">{s}</Badge></li>)}</ul></td>
              <td className="tabular-nums">{c.rateLimitPerMinute} / min</td>
              <td>{fmtDateTime(c.lastUsedAt)}</td>
              <td>{c.active ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Révoquée{c.revokedAt ? ` le ${new Date(c.revokedAt).toLocaleDateString('fr-FR')}` : ''}</Badge>}</td>
              <td>
                {c.active && (
                  <div className="flex flex-wrap gap-1">
                    <Button type="button" size="sm" variant="secondary" aria-label={`Nouvelle clé pour ${c.name}`} onClick={() => open({ kind: 'rotate', c })}>Rotation</Button>
                    <Button type="button" size="sm" variant="danger-ghost" aria-label={`Révoquer ${c.name}`} onClick={() => open({ kind: 'revoke', c })}>Révoquer</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <ConfirmDialog
        open={pending?.kind === 'rotate'}
        title={`Nouvelle clé pour ${pending?.c.name ?? ''}`}
        confirmLabel="Générer une nouvelle clé"
        variant="warn"
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => setPending(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        <p>L’ancienne clé cesse immédiatement de fonctionner : mettez à jour l’application consommatrice sans délai.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        title={`Révoquer ${pending?.c.name ?? ''}`}
        confirmLabel="Révoquer"
        variant="danger"
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => setPending(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        <p>La clé est refusée dès maintenant, définitivement. Pour rétablir l’accès, créer un nouveau client.</p>
      </ConfirmDialog>

      {creating && (
        <CreateClientDialog
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['api-clients'] });
            setSecret({ name: r.name, key: r.apiKey });
          }}
        />
      )}
      {secret && (
        <SecretOnceDialog title="Clé d’API — affichée une seule fois" label="Clé d’API" value={secret.key} doneLabel="J’ai conservé la clé" onClose={() => setSecret(null)}>
          <p>Client « {secret.name} » : en-tête <code>Authorization: Bearer &lt;clé&gt;</code> sur <code>/api/v1</code>.</p>
        </SecretOnceDialog>
      )}
    </RegionCard>
  );
}

function CreateClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: WithKey) => void }) {
  const uid = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [rate, setRate] = useState('120');
  const [formError, setFormError] = useState<string>();
  const m = useMutation({ mutationFn: (body: unknown) => apiRequest<WithKey>('POST', '/v1/admin/api-clients', body), onSuccess: onCreated });
  function submit() {
    const n = Number(rate.trim());
    if (!Number.isInteger(n) || n < 1 || n > 10000) return setFormError('Débit : entier entre 1 et 10 000 requêtes par minute.');
    setFormError(undefined);
    m.mutate({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), scopes, rateLimitPerMinute: n });
  }
  return (
    <ConfirmDialog
      open
      title="Nouveau client d’API"
      confirmLabel="Créer le client"
      disabled={!name.trim() || scopes.length === 0}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <Field label="Nom" htmlFor={`${uid}-name`} hint="L’application consommatrice, ex. « Client Help ».">
        <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`}>
        <Input id={`${uid}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs+ font-button text-ink-muted">Scopes (au moins un)</legend>
        {API_SCOPES.map(([s, d]) => (
          <label key={s} className="inline-flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={scopes.includes(s)}
              onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))}
            />
            <span><code>{s}</code> — {d}</span>
          </label>
        ))}
      </fieldset>
      <Field label="Débit maximal (requêtes par minute)" htmlFor={`${uid}-rate`}>
        <Input id={`${uid}-rate`} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
