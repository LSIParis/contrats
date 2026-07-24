import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPostForm, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { contractCategoryLabel } from '../../lib/labels.js';

export interface ImportCustomerRow { id: string; name: string; }

/** « 1500,50 » ou « 1500.50 » → 150050 centimes. Vide → undefined. */
function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;

export interface ContractImportFormProps {
  customers: ImportCustomerRow[];
  submitting: boolean;
  error?: string;
  onSubmit: (form: FormData) => void;
}

export function ContractImportForm({ customers, submitting, error, onSubmit }: ContractImportFormProps) {
  const [form, setForm] = useState({
    customerId: '', reference: '', title: '', category: 'MAINTENANCE',
    startDate: '', endDate: '', signedAt: '', noticePeriodDays: '', amount: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const ready = Boolean(form.customerId && form.reference.trim() && form.title.trim() && file);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !file) return;
    const fd = new FormData();
    fd.append('customerId', form.customerId);
    fd.append('reference', form.reference.trim());
    fd.append('title', form.title.trim());
    fd.append('category', form.category);
    if (form.startDate) fd.append('startDate', form.startDate);
    if (form.endDate) fd.append('endDate', form.endDate);
    if (form.signedAt) fd.append('signedAt', form.signedAt);
    if (form.noticePeriodDays.trim()) fd.append('noticePeriodDays', form.noticePeriodDays.trim());
    const cents = eurosToCents(form.amount);
    if (cents !== undefined) fd.append('amountCents', String(cents));
    fd.append('document', file);
    onSubmit(fd);
  }

  return (
    <form className="max-w-lg space-y-4" onSubmit={handleSubmit}>
      <Field label="Client" htmlFor="import-cust">
        <Select id="import-cust" value={form.customerId} onChange={set('customerId')} required>
          <option value="">— choisir —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Référence" htmlFor="import-reference">
        <Input id="import-reference" value={form.reference} onChange={set('reference')} required />
      </Field>
      <Field label="Titre" htmlFor="import-title">
        <Input id="import-title" value={form.title} onChange={set('title')} required />
      </Field>
      <Field label="Catégorie" htmlFor="import-cat">
        <Select id="import-cat" value={form.category} onChange={set('category')}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{contractCategoryLabel(c)}</option>)}
        </Select>
      </Field>
      <div className="flex gap-3">
        <Field label="Date de début" htmlFor="import-sd">
          <Input id="import-sd" type="date" value={form.startDate} onChange={set('startDate')} />
        </Field>
        <Field label="Date de fin" htmlFor="import-ed">
          <Input id="import-ed" type="date" value={form.endDate} onChange={set('endDate')} />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field label="Signé le" htmlFor="import-sat">
          <Input id="import-sat" type="date" value={form.signedAt} onChange={set('signedAt')} />
        </Field>
        <Field label="Préavis (jours)" htmlFor="import-np">
          <Input id="import-np" type="number" min="0" value={form.noticePeriodDays} onChange={set('noticePeriodDays')} />
        </Field>
      </div>
      <Field label="Montant (€)" htmlFor="import-amt">
        <Input id="import-amt" value={form.amount} onChange={set('amount')} placeholder="1500,00" />
      </Field>
      <Field label="Document (PDF ou DOCX)" htmlFor="import-doc">
        <input
          id="import-doc"
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm"
        />
      </Field>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!ready || submitting}
        className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50"
      >
        {submitting ? 'Import…' : 'Importer le contrat'}
      </button>
    </form>
  );
}

export function ContractImportPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const custs = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiGet<{ items: ImportCustomerRow[] }>('/v1/customers'),
  });

  const m = useMutation({
    mutationFn: (fd: FormData) => apiPostForm<{ id: string }>('/v1/contracts/import', fd),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`/contracts/${c.id}`);
    },
  });

  if (custs.isLoading) return <Spinner />;
  if (custs.error || !custs.data) return <p className="text-red-600">Erreur de chargement.</p>;
  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Importer un contrat existant</h1>
      <ContractImportForm
        customers={custs.data.items}
        submitting={m.isPending}
        error={error}
        onSubmit={(fd) => m.mutate(fd)}
      />
    </div>
  );
}
