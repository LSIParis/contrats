import { formatCents, formatDecimal, formatDecimalEuros } from '../../lib/money.js';
import { Icon } from '../../ui/icons.js';
import { Table } from '../../ui/table.js';
import { KIND_LABELS, RECURRENCE_LABELS, describeStep, fmtDay } from './labels.js';
import type { PriceAtResult, PricingTotals, TraceStep } from './types.js';

/** Totaux HT / TVA / TTC séparés + récurrents (brief §5), centimes en chaînes. */
export function TotalsList({ totals }: { totals: PricingTotals }) {
  const rows: Array<[string, string]> = [
    ['Total HT', formatCents(totals.htCents)],
    ...totals.vatByRate.map((v): [string, string] => [`TVA ${formatDecimal(v.ratePercent, { minFraction: 0 })} % (base ${formatCents(v.baseHtCents)})`, formatCents(v.vatCents)]),
    ['Total TVA', formatCents(totals.vatCents)],
    ['Total TTC', formatCents(totals.ttcCents)],
    ['Récurrent mensuel HT', formatCents(totals.monthlyRecurringCents)],
    ['Récurrent annuel HT', formatCents(totals.annualRecurringCents)],
  ];
  if (totals.oneOffCents && totals.oneOffCents !== '0') rows.push(['Ponctuel HT', formatCents(totals.oneOffCents)]);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums text-ink sm:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TraceList({ steps }: { steps: TraceStep[] }) {
  return (
    <ol className="ml-5 list-decimal text-13 text-ink-muted">
      {steps.map((s, i) => <li key={i}>{describeStep(s)}</li>)}
    </ol>
  );
}

export function PricingResultView({ result }: { result: PriceAtResult }) {
  const pending = result.pendingOverrides ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-13 text-ink-muted">
        Calcul au {fmtDay(result.date)} — version {result.scheduleVersion ?? '?'} du barème (valide du {fmtDay(result.scheduleValidFrom)}
        {result.scheduleValidTo ? ` au ${fmtDay(result.scheduleValidTo)}` : ', sans fin'}).
        {result.settings && ` Arrondi ${result.settings.rounding}, prix unitaire à ${result.settings.unitPriceScale} décimales.`}
      </p>
      {pending.length > 0 && (
        <p className="flex items-start gap-2 rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
          <Icon name="alert" />
          <span>
            {pending.length} dérogation{pending.length > 1 ? 's' : ''} en attente de seconde validation {pending.length > 1 ? 'ne sont pas appliquées' : 'n’est pas appliquée'} :{' '}
            {pending.map((o) => `${o.lineId} à ${formatDecimalEuros(o.unitPrice)} (« ${o.reason} »)`).join(' ; ')}.
          </span>
        </p>
      )}
      <Table
        caption={`Lignes du barème au ${fmtDay(result.date)}`}
        head={
          <tr>
            <th>Ligne</th><th>Type</th><th>Quantité</th><th>Prix unitaire HT</th><th>TVA</th><th>Total HT</th>
          </tr>
        }
      >
        {result.lines.map((l) => (
          <LineRows key={l.lineId} line={l} />
        ))}
      </Table>
      <TotalsList totals={result.totals} />
    </div>
  );
}

function LineRows({ line: l }: { line: PriceAtResult['lines'][number] }) {
  return (
    <>
      <tr>
        <td>
          <span className="font-medium text-ink">{l.label}</span>
          <span className="block text-xs text-ink-faint">{l.code} · {l.lineId}</span>
        </td>
        <td>{KIND_LABELS[l.kind] ?? l.kind}<span className="block text-xs text-ink-faint">{RECURRENCE_LABELS[l.recurrence] ?? l.recurrence}</span></td>
        <td className="tabular-nums">{formatDecimal(l.quantity, { minFraction: 0 })} {l.unit}</td>
        <td className="tabular-nums">{formatDecimalEuros(l.unitPrice)}</td>
        <td className="tabular-nums">{formatDecimal(l.vatRatePercent, { minFraction: 0 })} %</td>
        <td className="tabular-nums font-medium">{formatCents(l.totalHtCents)}</td>
      </tr>
      {l.trace && l.trace.length > 0 && (
        <tr>
          <td colSpan={6} className="bg-slate-50">
            <details open>
              <summary className="cursor-pointer text-13 text-primary">Trace de calcul — {l.label}</summary>
              <TraceList steps={l.trace} />
            </details>
          </td>
        </tr>
      )}
    </>
  );
}
