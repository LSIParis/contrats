import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';

interface CustomerRow { id: string; name: string; }

/** « 1500,50 » ou « 1500.50 » → 150050 centimes. Vide → undefined. */
function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;
const FREQ = ['MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF'] as const;

export function ContractNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const custs = useQuery({ queryKey: ['customers'], queryFn: () => apiGet<{ items: CustomerRow[] }>('/v1/customers') });
  const [form, setForm] = useState({
    customerId: params.get('customerId') ?? '',
    title: '', category: 'MAINTENANCE', startDate: '', endDate: '',
    noticePeriodDays: '', amount: '', billingFrequency: 'MONTHLY',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        customerId: form.customerId, title: form.title.trim(), category: form.category,
        billingFrequency: form.billingFrequency,
      };
      if (form.startDate) body.startDate = form.startDate;
      if (form.endDate) body.endDate = form.endDate;
      if (form.noticePeriodDays.trim()) body.noticePeriodDays = Number(form.noticePeriodDays);
      const cents = eurosToCents(form.amount);
      if (cents !== undefined) body.amountCents = cents;
      return apiPost<{ id: string }>('/v1/contracts', body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`/contracts/${c.id}`);
    },
  });

  if (custs.isLoading) return <Spinner />;
  const customers = custs.data?.items ?? [];
  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.customerId && form.title.trim();

  return (
    <form className="max-w-lg space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <h1 className="text-xl font-semibold">Nouveau contrat</h1>
      <Field label="Client" htmlFor="cust">
        <Select id="cust" value={form.customerId} onChange={set('customerId')} required>
          <option value="">— choisir —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Titre" htmlFor="title"><Input id="title" value={form.title} onChange={set('title')} required /></Field>
      <Field label="Catégorie" htmlFor="cat">
        <Select id="cat" value={form.category} onChange={set('category')}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <div className="flex gap-3">
        <Field label="Date de début" htmlFor="sd"><Input id="sd" type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="Date de fin" htmlFor="ed"><Input id="ed" type="date" value={form.endDate} onChange={set('endDate')} /></Field>
      </div>
      <div className="flex gap-3">
        <Field label="Préavis (jours)" htmlFor="np"><Input id="np" type="number" min="0" value={form.noticePeriodDays} onChange={set('noticePeriodDays')} /></Field>
        <Field label="Montant (€)" htmlFor="amt"><Input id="amt" value={form.amount} onChange={set('amount')} placeholder="1500,00" /></Field>
      </div>
      <Field label="Facturation" htmlFor="bf">
        <Select id="bf" value={form.billingFrequency} onChange={set('billingFrequency')}>
          {FREQ.map((f) => <option key={f} value={f}>{f}</option>)}
        </Select>
      </Field>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50">
        {m.isPending ? 'Création…' : 'Créer le contrat'}
      </button>
    </form>
  );
}
