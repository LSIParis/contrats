import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { PricingResultView } from './pricing-result.js';
import type { PriceAtResult, ScheduleView } from './types.js';

/** Date du jour à Paris (« YYYY-MM-DD »), comme le défaut de l'API. */
export function todayParis(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

type Params = { at: string; trace: boolean; version: string };

export function pricingUrl(contractId: string, p: Params): string {
  const q = new URLSearchParams({ at: p.at });
  if (p.trace) q.set('trace', 'true');
  if (p.version) q.set('version', p.version);
  return `/v1/contracts/${contractId}/pricing?${q.toString()}`;
}

/**
 * `priceAt(contractId, date)` : barème applicable à une date, trace sur
 * demande, prévisualisation d'une version (brouillon compris). Calculé
 * d'office à la date du jour quand une version est engagée.
 */
export function PriceAtCard({ contractId, schedules }: { contractId: string; schedules: ScheduleView[] }) {
  const uid = useId();
  const [form, setForm] = useState<Params>({ at: todayParis(), trace: false, version: '' });
  const [params, setParams] = useState<Params | null>(null);
  const engaged = schedules.some((s) => s.status !== 'DRAFT');

  useEffect(() => {
    if (engaged && params === null) setParams({ at: todayParis(), trace: false, version: '' });
  }, [engaged, params]);

  const q = useQuery({
    queryKey: ['pricing-at', contractId, params],
    queryFn: () => apiRequest<PriceAtResult>('GET', pricingUrl(contractId, params!)),
    enabled: params !== null,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.at) return;
    setParams({ ...form });
  }

  return (
    <RegionCard title="Prix à une date">
      <form onSubmit={submit} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
        <Field label="Date du calcul" htmlFor={`${uid}-at`}>
          <Input id={`${uid}-at`} type="date" value={form.at} onChange={(e) => setForm((f) => ({ ...f, at: e.target.value }))} required />
        </Field>
        <Field label="Version" htmlFor={`${uid}-v`}>
          <Select id={`${uid}-v`} value={form.version} onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}>
            <option value="">Version en vigueur à la date</option>
            {schedules.map((s) => (
              <option key={s.version} value={String(s.version)}>
                Prévisualiser la version {s.version}{s.status === 'DRAFT' ? ' (brouillon)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <label className="inline-flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={form.trace} onChange={(e) => setForm((f) => ({ ...f, trace: e.target.checked }))} />
          Afficher la trace de calcul
        </label>
        <Button type="submit">Calculer</Button>
      </form>
      {params && q.isFetching && <Spinner label="Calcul…" />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && !q.isFetching && <PricingResultView result={q.data} />}
      {!params && <p className="text-13 text-ink-faint">Aucune version engagée : choisir une date et une version à prévisualiser.</p>}
    </RegionCard>
  );
}
