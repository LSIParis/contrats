import { useState } from 'react';
import { Input } from '../../../ui/input.js';
import type { Bucket, DefLine, PublicView, Quote, Selection } from './public-api.js';
import { formatEuros } from './public-api.js';

type Pricing = NonNullable<PublicView['content']>['pricing'];

/**
 * Tableau de prix interactif (brief §12.4).
 *
 * AUCUN calcul de prix ici : chaque changement part au serveur (`PUT …/selection`),
 * qui recalcule avec le moteur de tarification et renvoie le devis complet ; la
 * page n'affiche que ce devis. Seuls les éléments ouverts au client sont modifiables
 * (formules et durées `editableByClient`, options facultatives, quantités bornées).
 */
export function PricingTable({
  pricing,
  editable,
  onChange,
}: {
  pricing: { definition: Pricing['definition']; selection: Selection; quote: Quote };
  editable: boolean;
  onChange: (change: Partial<Selection>) => Promise<void>;
}) {
  const { definition, selection, quote } = pricing;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, string>>({});

  const send = async (change: Partial<Selection>) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(change);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const optional = definition.lines.filter((l) => l.kind === 'OPTIONAL');
  const editableQty = definition.lines.filter(
    (l) => l.quantity?.editableByClient && (l.kind === 'REQUIRED' || selection.selectedOptions.includes(l.key)),
  );
  const choiceValue = (key: string) => quote.choices[key] ?? selection.choices[key] ?? '';

  return (
    <div className="flex flex-col gap-5" aria-busy={busy}>
      {editable && (
        <fieldset className="flex flex-col gap-4 rounded-lg border border-line bg-slate-50 p-4" disabled={busy}>
          <legend className="px-1 text-sm font-title text-ink">Configurez votre offre</legend>
          {definition.choices.filter((c) => c.editableByClient).map((c) => (
            <div key={c.key} role="radiogroup" aria-labelledby={`choix-${c.key}`} className="flex flex-col gap-2">
              <span id={`choix-${c.key}`} className="text-xs+ font-button text-ink-muted">{c.label}</span>
              <div className="flex flex-wrap gap-2">
                {c.options.map((o) => (
                  <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded border border-line-strong bg-surface px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name={`choix-${c.key}`}
                      value={o.value}
                      checked={choiceValue(c.key) === o.value}
                      onChange={() => void send({ choices: { [c.key]: o.value } })}
                    />
                    <span>{o.label}{o.description ? <span className="text-ink-faint"> — {o.description}</span> : null}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {optional.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs+ font-button text-ink-muted">Options</span>
              {optional.map((l) => (
                <label key={l.key} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selection.selectedOptions.includes(l.key)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selection.selectedOptions, l.key]
                        : selection.selectedOptions.filter((k) => k !== l.key);
                      void send({ selectedOptions: next });
                    }}
                  />
                  <span>
                    {l.label}
                    {l.description && <span className="block text-xs text-ink-faint">{l.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          {editableQty.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {editableQty.map((l) => (
                <QuantityInput
                  key={l.key}
                  line={l}
                  value={draftQty[l.key] ?? String(quote.quantities[l.key] ?? selection.quantities[l.key] ?? '')}
                  onDraft={(v) => setDraftQty((d) => ({ ...d, [l.key]: v }))}
                  onCommit={(n) => void send({ quantities: { [l.key]: n } })}
                />
              ))}
            </div>
          )}
        </fieldset>
      )}

      {error && <p role="alert" className="text-13 text-danger">{error}</p>}
      {quote.errors.length > 0 && (
        <div role="alert" className="rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
          <p className="font-button">Configuration à compléter :</p>
          <ul className="list-disc pl-5">{quote.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <caption className="sr-only">Détail du prix (montants hors taxes)</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs+ text-ink-muted">
              <th scope="col" className="py-2 pr-3 font-button">Prestation</th>
              <th scope="col" className="py-2 pr-3 text-right font-button">Qté</th>
              <th scope="col" className="py-2 pr-3 font-button">Unité</th>
              <th scope="col" className="py-2 pr-3 text-right font-button">Prix unitaire HT</th>
              <th scope="col" className="py-2 text-right font-button">Total HT</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => {
              const special = l.recurrence === 'DISCOUNT' || l.recurrence === 'MINIMUM';
              return (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{l.label}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{special ? '' : l.quantity}</td>
                  <td className="py-2 pr-3 text-ink-muted">{special ? '' : l.unit}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{special ? '' : `${l.priceFrom ? 'à partir de ' : ''}${formatEuros(l.unitPriceCents)}`}</td>
                  <td className="py-2 text-right tabular-nums">{formatEuros(l.totalHtCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Totals quote={quote} />

      {quote.infoLines.length > 0 && (
        <div className="text-13 text-ink-muted">
          <p className="font-button text-ink">Tarifs hors forfait</p>
          <ul className="list-disc pl-5">
            {quote.infoLines.map((l) => (
              <li key={l.key}>{l.label} — {formatEuros(l.unitPriceCents)} HT / {l.unit}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function QuantityInput({ line, value, onDraft, onCommit }: { line: DefLine; value: string; onDraft: (v: string) => void; onCommit: (n: number) => void }) {
  const id = `quantite-${line.key}`;
  const q = line.quantity!;
  const commit = () => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0) onCommit(n);
  };
  return (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{line.label} ({line.unit})</label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={q.min}
        {...(q.max !== null ? { max: q.max } : {})}
        step={1}
        value={value}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </div>
  );
}

function Totals({ quote }: { quote: Quote }) {
  const rows: [string, Bucket][] = [
    ['Mise en service (ponctuel)', quote.totals.oneTime],
    ['Mensuel récurrent', quote.totals.monthly],
    ['Trimestriel', quote.totals.quarterly],
    ['Prestations annuelles', quote.totals.yearly],
    [`Total sur ${quote.commitmentMonths} mois d’engagement (hors mise en service)`, quote.totals.commitment],
  ];
  return (
    <dl className="grid gap-2 rounded-lg border border-line bg-surface p-4 text-sm" aria-label="Totaux">
      {rows
        .filter(([label, b]) => b.htCents !== 0 || label === 'Mensuel récurrent')
        .map(([label, b]) => (
          <div key={label} className="grid grid-cols-1 gap-1 border-b border-line pb-2 last:border-0 last:pb-0 sm:grid-cols-[1fr_auto_auto_auto] sm:gap-4">
            <dt className="font-button text-ink">{label}</dt>
            <dd className="tabular-nums" data-total={label}>{formatEuros(b.htCents)} HT</dd>
            <dd className="tabular-nums text-ink-muted">{formatEuros(b.vatCents)} TVA</dd>
            <dd className="tabular-nums font-button">{formatEuros(b.ttcCents)} TTC</dd>
          </div>
        ))}
    </dl>
  );
}
