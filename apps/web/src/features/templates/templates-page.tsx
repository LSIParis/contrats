import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { contractCategoryLabel, templateStatusLabel } from '../../lib/labels.js';

interface TemplateRow {
  id: string; name: string; category: string; status: string;
  versionCount: number; updatedAt: string;
}

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;

function NewTemplateForm({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('MAINTENANCE');

  const m = useMutation({
    mutationFn: () => apiPost<{ id: string }>('/v1/templates', { name: name.trim(), category }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['templates'] });
      onDone(t.id);
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = name.trim().length > 0;

  return (
    <form
      className="max-w-lg space-y-4 rounded border p-4"
      onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}
    >
      <h2 className="text-lg font-semibold">Nouveau modèle</h2>
      <Field label="Nom" htmlFor="name">
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Catégorie" htmlFor="category">
        <Select id="category" value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{contractCategoryLabel(c)}</option>)}
        </Select>
      </Field>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">
        {m.isPending ? 'Création…' : 'Créer'}
      </button>
    </form>
  );
}

export function TemplatesPage() {
  const nav = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const q = useQuery({ queryKey: ['templates'], queryFn: () => apiGet<{ items: TemplateRow[] }>('/v1/templates') });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Modèles de contrats</h1>
        {!showForm && (
          <button type="button" onClick={() => setShowForm(true)} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">
            Nouveau modèle
          </button>
        )}
      </div>
      {showForm && (
        <NewTemplateForm
          onDone={(id) => { setShowForm(false); nav(`/templates/${id}`); }}
        />
      )}
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p className="text-red-600">Erreur de chargement.</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-gray-400">Aucun modèle.</p>
      ) : (
        <Table head={<tr><th className="py-2">Nom</th><th>Catégorie</th><th>Statut</th><th>Versions</th></tr>}>
          {q.data.items.map((t) => (
            <tr key={t.id} className="border-b hover:bg-gray-50">
              <td className="py-2"><Link to={`/templates/${t.id}`} className="text-lsi hover:underline">{t.name}</Link></td>
              <td>{contractCategoryLabel(t.category)}</td>
              <td>{templateStatusLabel(t.status)}</td>
              <td>{t.versionCount}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
