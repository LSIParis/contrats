import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { decimalFromInput, formatCents, formatDecimal, formatDecimalEuros } from '../../lib/money.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { TotalsList } from './pricing-result.js';
import { fmtDay } from './labels.js';
import type { PricingRuleRow, QuoteResult } from './types.js';

/**
 * Devis rapide (`POST /v1/pricing/quote`, 04 §17.6) : prix d'un article pour
 * une quantité et une date. Le barème du contrat fait foi s'il porte
 * l'article (contrat désigné, ou unique contrat du client) ; sinon la grille
 * du catalogue. Même service que la future route publique.
 */
export function QuotePanel() {
  const uid = useId();
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => apiRequest<{ items: Array<{ id: string; name: string }> }>('GET', '/v1/customers') });
  const rules = useQuery({ queryKey: ['pricing-rules', false], queryFn: () => apiRequest<{ items: PricingRuleRow[] }>('GET', '/v1/pricing-rules') });
  const grids = (rules.data?.items ?? []).filter((r) => r.type === 'GRID' && !r.archivedAt);
  const [f, setF] = useState({ articleCode: '', quantity: '', date: '', customerId: '', contractId: '', ruleCode: '', vat: '' });
  const [formError, setFormError] = useState<string>();
  const m = useMutation({ mutationFn: (body: unknown) => apiRequest<QuoteResult>('POST', '/v1/pricing/quote', body) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const quantity = decimalFromInput(f.quantity);
    if (!f.articleCode.trim()) return setFormError('Code article obligatoire.');
    if (!quantity) return setFormError('Quantité invalide.');
    const vat = decimalFromInput(f.vat, { maxFraction: 2 });
    if (vat === null) return setFormError('Taux de TVA invalide.');
    setFormError(undefined);
    m.mutate({
      articleCode: f.articleCode.trim(),
      quantity,
      ...(f.date ? { date: f.date } : {}),
      ...(f.contractId.trim() ? { contractId: f.contractId.trim() } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.ruleCode ? { ruleCode: f.ruleCode } : {}),
      ...(vat ? { vatRatePercent: vat } : {}),
    });
  }

  const r = m.data;
  return (
    <RegionCard title="Devis rapide">
      <form noValidate onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Code article" htmlFor={`${uid}-art`}>
          <Input id={`${uid}-art`} value={f.articleCode} onChange={set('articleCode')} />
        </Field>
        <Field label="Quantité" htmlFor={`${uid}-qty`}>
          <Input id={`${uid}-qty`} inputMode="decimal" value={f.quantity} onChange={set('quantity')} />
        </Field>
        <Field label="Date (facultatif)" htmlFor={`${uid}-date`} hint="Défaut : aujourd’hui.">
          <Input id={`${uid}-date`} type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Client (facultatif)" htmlFor={`${uid}-cust`} hint="Le barème de son contrat portant l’article fait foi.">
          <Select id={`${uid}-cust`} value={f.customerId} onChange={set('customerId')}>
            <option value="">(aucun — catalogue)</option>
            {(customers.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Contrat (identifiant, facultatif)" htmlFor={`${uid}-ctr`} hint="Si plusieurs contrats du client portent l’article.">
          <Input id={`${uid}-ctr`} value={f.contractId} onChange={set('contractId')} />
        </Field>
        <Field label="Grille du catalogue (facultatif)" htmlFor={`${uid}-rule`} hint="Si plusieurs grilles portent l’article.">
          <Select id={`${uid}-rule`} value={f.ruleCode} onChange={set('ruleCode')}>
            <option value="">(automatique)</option>
            {grids.map((g) => <option key={g.code} value={g.code}>{g.code} — {g.label}</option>)}
          </Select>
        </Field>
        <Field label="Taux de TVA (%) (facultatif)" htmlFor={`${uid}-vat`} hint="Catalogue : 20 % par défaut.">
          <Input id={`${uid}-vat`} inputMode="decimal" value={f.vat} onChange={set('vat')} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Calcul…' : 'Calculer le prix'}</Button>
        </div>
      </form>
      <ErrorNote>{formError ?? errorText(m.error)}</ErrorNote>
      {r && !m.error && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            {r.source === 'CONTRACT' ? (
              <>
                Barème du contrat — version {r.scheduleVersion ?? '?'}{' '}
                {r.contractId && <Link className="text-primary hover:underline" to={`/contracts/${r.contractId}?onglet=tarification`}>(voir le contrat)</Link>}
              </>
            ) : (
              <>Catalogue du tenant — règle {r.ruleCode}</>
            )}
            {' '}· article {r.articleCode} · {formatDecimal(r.quantity, { minFraction: 0 })} {r.line.unit} · au {fmtDay(r.date)}
          </p>
          <p className="text-sm">
            Prix unitaire HT : <strong>{formatDecimalEuros(r.line.unitPrice)}</strong> — total HT de la ligne : <strong>{formatCents(r.line.totalHtCents)}</strong>
          </p>
          <TotalsList totals={r.totals} />
        </div>
      )}
    </RegionCard>
  );
}
