import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Table } from '../../ui/table.js';
import { roleLabel, userKindLabel } from '../../lib/labels.js';

interface CustomerRow { id: string; name: string; }
interface UserRow {
  id: string; email: string; fullName: string; kind: 'INTERNAL' | 'CLIENT';
  status: 'ACTIVE' | 'DISABLED'; roles: string[]; customer: { id: string; name: string } | null;
}

const INTERNAL_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN'] as const;
const CLIENT_ROLES = ['CLIENT_SIGNER', 'CLIENT_VIEWER'] as const;

function RoleCheckboxes({ codes, selected, onToggle }: { codes: readonly string[]; selected: string[]; onToggle: (code: string) => void }) {
  return (
    <div className="space-y-1">
      {codes.map((code) => (
        <label key={code} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(code)} onChange={() => onToggle(code)} />
          {roleLabel(code)}
        </label>
      ))}
    </div>
  );
}

function NewUserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'INTERNAL' | 'CLIENT'>('INTERNAL');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [roles, setRoles] = useState<string[]>([]);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiGet<{ items: CustomerRow[] }>('/v1/customers'),
    enabled: kind === 'CLIENT',
  });

  const toggleRole = (code: string) => {
    setRoles((prev) => (prev.includes(code) ? prev.filter((r) => r !== code) : [...prev, code]));
  };

  const setKindAndResetRoles = (k: 'INTERNAL' | 'CLIENT') => {
    setKind(k);
    setRoles([]);
  };

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { kind, email: email.trim(), fullName: fullName.trim(), roles };
      if (kind === 'CLIENT') body.customerId = customerId;
      return apiPost<{ id: string }>('/v1/users', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = email.trim() && fullName.trim() && (kind === 'INTERNAL' || customerId);

  return (
    <form
      className="max-w-lg space-y-4 rounded border p-4"
      onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}
    >
      <h2 className="text-lg font-semibold">Nouvel utilisateur</h2>
      <Field label="Type" htmlFor="kind">
        <Select id="kind" value={kind} onChange={(e) => setKindAndResetRoles(e.target.value as 'INTERNAL' | 'CLIENT')}>
          <option value="INTERNAL">Interne</option>
          <option value="CLIENT">Client</option>
        </Select>
      </Field>
      <Field label="Email" htmlFor="email"><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Field label="Nom" htmlFor="fullName"><Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></Field>
      {kind === 'CLIENT' ? (
        <>
          <Field label="Client" htmlFor="customerId">
            <Select id="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">— choisir —</option>
              {(customers.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <div>
            <div className="mb-1 text-sm font-medium text-gray-700">Rôles</div>
            <RoleCheckboxes codes={CLIENT_ROLES} selected={roles} onToggle={toggleRole} />
          </div>
        </>
      ) : (
        <div>
          <div className="mb-1 text-sm font-medium text-gray-700">Rôles</div>
          <RoleCheckboxes codes={INTERNAL_ROLES} selected={roles} onToggle={toggleRole} />
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">
          {m.isPending ? 'Création…' : 'Créer'}
        </button>
        <button type="button" onClick={onDone} className="rounded border px-4 py-2 text-sm">Annuler</button>
      </div>
    </form>
  );
}

function RoleEditor({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const qc = useQueryClient();
  const [roles, setRoles] = useState<string[]>(user.roles);
  const codes = user.kind === 'CLIENT' ? CLIENT_ROLES : INTERNAL_ROLES;

  const toggleRole = (code: string) => {
    setRoles((prev) => (prev.includes(code) ? prev.filter((r) => r !== code) : [...prev, code]));
  };

  const m = useMutation({
    mutationFn: () => apiPatch<{ ok: true }>(`/v1/users/${user.id}`, { roles }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <div className="space-y-2 rounded border p-3">
      <RoleCheckboxes codes={codes} selected={roles} onToggle={toggleRole} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => m.mutate()} disabled={m.isPending} className="rounded bg-lsi px-3 py-1 text-xs text-white hover:bg-lsi-dark disabled:opacity-50">
          {m.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button type="button" onClick={onDone} className="rounded border px-3 py-1 text-xs">Annuler</button>
      </div>
    </div>
  );
}

function UserActions({ user }: { user: UserRow }) {
  const qc = useQueryClient();
  const [editingRoles, setEditingRoles] = useState(false);

  const toggleStatus = useMutation({
    mutationFn: () => apiPatch<{ ok: true }>(`/v1/users/${user.id}`, { status: user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const error = toggleStatus.error instanceof ApiError ? toggleStatus.error.message : toggleStatus.error ? 'Erreur.' : undefined;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => toggleStatus.mutate()}
          disabled={toggleStatus.isPending}
          className="rounded border px-3 py-1 text-xs disabled:opacity-50"
        >
          {user.status === 'ACTIVE' ? 'Désactiver' : 'Activer'}
        </button>
        <button type="button" onClick={() => setEditingRoles((v) => !v)} className="rounded border px-3 py-1 text-xs">
          {editingRoles ? 'Fermer' : 'Rôles'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {editingRoles && <RoleEditor user={user} onDone={() => setEditingRoles(false)} />}
    </div>
  );
}

export function UsersPage() {
  const [showForm, setShowForm] = useState(false);
  const q = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ items: UserRow[] }>('/v1/users') });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Utilisateurs</h1>
        {!showForm && (
          <button type="button" onClick={() => setShowForm(true)} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">
            Nouvel utilisateur
          </button>
        )}
      </div>
      {showForm && <NewUserForm onDone={() => setShowForm(false)} />}
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucun utilisateur.</p>
      ) : (
        <Table head={<tr><th className="py-2">Nom</th><th>Email</th><th>Type</th><th>Client</th><th>Rôles</th><th>Statut</th><th /></tr>}>
          {q.data.items.map((u) => (
            <tr key={u.id} className="border-b align-top hover:bg-gray-50">
              <td className="py-2">{u.fullName}</td>
              <td>{u.email}</td>
              <td>{userKindLabel(u.kind)}</td>
              <td>{u.customer?.name ?? '—'}</td>
              <td>{u.roles.map((r) => roleLabel(r)).join(', ') || '—'}</td>
              <td>{u.status === 'ACTIVE' ? 'Actif' : 'Désactivé'}</td>
              <td><UserActions user={u} /></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
