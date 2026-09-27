import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { decimalFromInput, formatCents, formatDecimal, formatDecimalEuros } from '../../lib/money.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Table } from '../../ui/table.js';
import { todayParis } from './price-at-card.js';
import { PricingResultView } from './pricing-result.js';
import type { ScheduleView, SimulationResult } from './types.js';

/** Version engagée applicable à `at`, sinon la plus récente (pour proposer ses lignes). */
export function scheduleAt(schedules: ScheduleView[], at: string): ScheduleView | undefined {
  const engaged = schedules.filter((s) => s.status !== 'DRAFT');
  return (
    engaged.find((s) => s.validFrom <= at && (s.validTo === null || at <= s.validTo)) ??
    [...engaged].sort((a, b) => b.version - a.version)[0]
  );
}

const pct = (p: string | null) => (p == null ? '—' : `${p.startsWith('-') ? '' : '+'}${formatDecimal(p, { minFraction: 0 })} %`);

/**
 * Simulateur (brief §5, 04 §12) : impact d'une révision (valeur d'indice
 * hypothétique), d'un changement de quantité ou de prix de base, avant
 * application. Même moteur que le calcul réel : le prix simulé est celui qui
 * serait facturé.
 */
export function SimulatorCard({ contractId, schedules }: { contractId: string; schedules: ScheduleView[] }) {
  const uid = useId();
  const [at, setAt] = useState(todayParis());
  const [beforeDate, setBeforeDate] = useState('');
  const [trace, setTrace] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [indexValues, setIndexValues] = useState<Array<{ indexCode: string; period: string; value: string }>>([]);
  const [formError, setFormError] = useState<string>();
  const schedule = scheduleAt(schedules, at);
  const lines = (schedule?.lines ?? []).filter((l) => l.kind !== 'DISCOUNT');

  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<SimulationResult>('POST', `/v1/contracts/${contractId}/pricing/simulate`, body),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const bad: string[] = [];
    const quantities = lines.flatMap((l) => {
      const v = decimalFromInput(qty[l.lineKey] ?? '');
      if (v === null) bad.push(`quantité de « ${l.label} »`);
      return v ? [{ lineId: l.lineKey, quantity: v }] : [];
    });
    const linePrices = lines.flatMap((l) => {
      const v = decimalFromInput(prices[l.lineKey] ?? '');
      if (v === null) bad.push(`prix de « ${l.label} »`);
      return v ? [{ lineId: l.lineKey, unitPrice: v }] : [];
    });
    const idx = indexValues.flatMap((x, i) => {
      if (!x.indexCode.trim() && !x.period.trim() && !x.value.trim()) return [];
      const v = decimalFromInput(x.value);
      if (!v || !/^\d{4}-(0[1-9]|1[0-2])$/.test(x.period.trim())) {
        bad.push(`valeur d’indice ${i + 1} (période AAAA-MM et valeur attendues)`);
        return [];
      }
      return [{ indexCode: x.indexCode.trim().toUpperCase(), period: x.period.trim(), value: v }];
    });
    if (bad.length) {
      setFormError(`Saisie invalide : ${bad.join(', ')}.`);
      return;
    }
    setFormError(undefined);
    const changes: Record<string, unknown> = {};
    if (quantities.length) changes.quantities = quantities;
    if (linePrices.length) changes.linePrices = linePrices;
    if (idx.length) changes.indexValues = idx;
    m.mutate({ at, ...(beforeDate ? { beforeDate } : {}), ...(trace ? { trace: true } : {}), changes });
  }

  const r = m.data;
  return (
    <RegionCard title="Simulateur">
      <p className="text-13 text-ink-muted">
        Compare le barème « avant » (tel quel, à la date « avant » ou à la même date) et « après » (avec les changements saisis).
        Rien n’est enregistré.
      </p>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <Field label="Date « après »" htmlFor={`${uid}-at`}>
            <Input id={`${uid}-at`} type="date" value={at} onChange={(e) => setAt(e.target.value)} required />
          </Field>
          <Field label="Date « avant » (facultatif)" htmlFor={`${uid}-before`} hint="Ex. aujourd’hui, pour voir l’effet de la prochaine révision.">
            <Input id={`${uid}-before`} type="date" value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)} />
          </Field>
          <label className="inline-flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={trace} onChange={(e) => setTrace(e.target.checked)} />
            Inclure la trace
          </label>
        </div>
        {lines.length > 0 ? (
          <Table
            caption={`Changements par ligne (version ${schedule?.version})`}
            head={<tr><th>Ligne</th><th>Quantité actuelle</th><th>Nouvelle quantité</th><th>Nouveau prix de base HT (€)</th></tr>}
          >
            {lines.map((l) => (
              <tr key={l.lineKey}>
                <td>{l.label}<span className="block text-xs text-ink-faint">{l.lineKey}</span></td>
                <td className="tabular-nums">{l.quantitySource === 'PROVIDER' ? 'fournie' : formatDecimal(l.quantity ?? '1', { minFraction: 0 })} {l.unit}</td>
                <td>
                  <Input
                    aria-label={`Nouvelle quantité — ${l.label}`}
                    inputMode="decimal"
                    value={qty[l.lineKey] ?? ''}
                    onChange={(e) => setQty((s) => ({ ...s, [l.lineKey]: e.target.value }))}
                  />
                </td>
                <td>
                  {l.kind === 'TIERED' ? (
                    <span className="text-xs text-ink-faint">sans objet (paliers)</span>
                  ) : (
                    <Input
                      aria-label={`Nouveau prix de base — ${l.label}`}
                      inputMode="decimal"
                      placeholder={l.unitPrice ? formatDecimalEuros(l.unitPrice) : undefined}
                      value={prices[l.lineKey] ?? ''}
                      onChange={(e) => setPrices((s) => ({ ...s, [l.lineKey]: e.target.value }))}
                    />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-13 text-ink-faint">Aucune version engagée : pas de ligne à simuler.</p>
        )}
        <div className="flex flex-col gap-2">
          {indexValues.map((x, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field label={`Indice ${i + 1}`} htmlFor={`${uid}-ic-${i}`}>
                <Input id={`${uid}-ic-${i}`} value={x.indexCode} onChange={(e) => setIndexValues((xs) => xs.map((y, j) => (j === i ? { ...y, indexCode: e.target.value } : y)))} />
              </Field>
              <Field label={`Période ${i + 1}`} htmlFor={`${uid}-ip-${i}`} hint="AAAA-MM">
                <Input id={`${uid}-ip-${i}`} placeholder="2026-06" value={x.period} onChange={(e) => setIndexValues((xs) => xs.map((y, j) => (j === i ? { ...y, period: e.target.value } : y)))} />
              </Field>
              <Field label={`Valeur ${i + 1}`} htmlFor={`${uid}-iv-${i}`}>
                <Input id={`${uid}-iv-${i}`} inputMode="decimal" value={x.value} onChange={(e) => setIndexValues((xs) => xs.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
              </Field>
              <Button type="button" variant="danger-ghost" size="sm" onClick={() => setIndexValues((xs) => xs.filter((_, j) => j !== i))}>
                Retirer la valeur {i + 1}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setIndexValues((xs) => [...xs, { indexCode: '', period: '', value: '' }])}>
              Ajouter une valeur d’indice
            </Button>
            <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Simulation…' : 'Simuler'}</Button>
          </div>
        </div>
      </form>
      <ErrorNote>{formError ?? errorText(m.error)}</ErrorNote>
      {r && (
        <div className="flex flex-col gap-3">
          <Table caption="Écarts par ligne" head={<tr><th>Ligne</th><th>Avant (HT)</th><th>Après (HT)</th><th>Écart</th><th>Écart %</th></tr>}>
            {r.lineDeltas.map((d) => (
              <tr key={d.lineId}>
                <td>{d.label}</td>
                <td className="tabular-nums">{formatCents(d.beforeCents)}</td>
                <td className="tabular-nums">{formatCents(d.afterCents)}</td>
                <td className="tabular-nums font-medium">{formatCents(d.deltaCents, { signed: true })}</td>
                <td className="tabular-nums">{pct(d.deltaPercent)}</td>
              </tr>
            ))}
          </Table>
          <Table caption="Écarts sur les totaux" head={<tr><th>Total</th><th>Avant</th><th>Après</th><th>Écart</th></tr>}>
            {([
              ['HT', 'htCents'], ['TVA', 'vatCents'], ['TTC', 'ttcCents'],
              ['Récurrent mensuel HT', 'monthlyRecurringCents'], ['Récurrent annuel HT', 'annualRecurringCents'],
            ] as const).map(([label, k]) => (
              <tr key={k}>
                <td>{label}</td>
                <td className="tabular-nums">{formatCents(r.before.totals[k])}</td>
                <td className="tabular-nums">{formatCents(r.after.totals[k])}</td>
                <td className="tabular-nums font-medium">{formatCents(r.totalsDelta[k], { signed: true })}</td>
              </tr>
            ))}
          </Table>
          {trace && (
            <details>
              <summary className="cursor-pointer text-13 text-primary">Barème « après » détaillé, avec la trace</summary>
              <PricingResultView result={r.after} />
            </details>
          )}
        </div>
      )}
    </RegionCard>
  );
}
