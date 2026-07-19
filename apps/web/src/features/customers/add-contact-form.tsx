import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, ApiError } from '../../lib/api.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';

export function AddContactForm({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', isPrimary: false });
  const set = (k: 'firstName' | 'lastName' | 'email') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () => apiPost(`/v1/customers/${customerId}/contacts`, {
      firstName: form.firstName.trim(), lastName: form.lastName.trim(),
      email: form.email.trim(), isPrimary: form.isPrimary,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customerId] });
      setForm({ firstName: '', lastName: '', email: '', isPrimary: false });
    },
  });

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  const ready = form.firstName.trim() && form.lastName.trim() && form.email.trim();

  return (
    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <Field label="Prénom" htmlFor="cf"><Input id="cf" value={form.firstName} onChange={set('firstName')} /></Field>
      <Field label="Nom" htmlFor="cl"><Input id="cl" value={form.lastName} onChange={set('lastName')} /></Field>
      <Field label="Email" htmlFor="ce"><Input id="ce" type="email" value={form.email} onChange={set('email')} /></Field>
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} /> Principal</label>
      <button type="submit" disabled={!ready || m.isPending} className="rounded bg-lsi px-3 py-1.5 text-sm text-white hover:bg-lsi-dark disabled:opacity-50">Ajouter</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}
