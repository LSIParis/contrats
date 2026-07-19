import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';

interface CreatedCustomer { id: string; name: string; }

export function CustomerNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', siren: '', addressLine1: '', postalCode: '', city: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { name: form.name.trim() };
      for (const k of ['siren', 'addressLine1', 'postalCode', 'city'] as const) {
        if (form[k].trim()) body[k] = form[k].trim();
      }
      return apiPost<CreatedCustomer>('/v1/customers', body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      nav(`/customers/${c.id}`);
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;

  return (
    <form
      className="max-w-lg space-y-4"
      onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) m.mutate(); }}
    >
      <h1 className="text-xl font-semibold">Nouveau client</h1>
      <Field label="Nom" htmlFor="name"><Input id="name" value={form.name} onChange={set('name')} required /></Field>
      <Field label="SIREN (9 chiffres, optionnel)" htmlFor="siren"><Input id="siren" value={form.siren} onChange={set('siren')} /></Field>
      <Field label="Adresse" htmlFor="addr"><Input id="addr" value={form.addressLine1} onChange={set('addressLine1')} /></Field>
      <div className="flex gap-3">
        <Field label="Code postal" htmlFor="cp"><Input id="cp" value={form.postalCode} onChange={set('postalCode')} /></Field>
        <Field label="Ville" htmlFor="city"><Input id="city" value={form.city} onChange={set('city')} /></Field>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!form.name.trim() || m.isPending}
        className="rounded bg-lsi px-4 py-2 text-white hover:bg-lsi-dark disabled:opacity-50"
      >
        {m.isPending ? 'Création…' : 'Créer le client'}
      </button>
    </form>
  );
}
