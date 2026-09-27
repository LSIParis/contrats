import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { centsToEurosInput, eurosToCents, formatCents } from '../../lib/money.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { useToast } from '../../ui/toast.js';
import {
  proposalsApi, type Bucket, type DefLine, type PendingValidation, type PricingDefinition, type ProposalDetail, type SelectionBody,
} from './proposal-api.js';
import { PRICE_SCOPE_LABELS, RECURRENCE_LABELS } from './proposal-labels.js';

/**
 * Tableau de prix interne (brief §12.4). AUCUN calcul de prix ici : chaque
 * changement de configuration part au serveur (`PUT …/selection`), qui
 * recalcule avec le moteur et renvoie le devis complet ; les montants sont des
 * chaînes de centimes seulement formatées (`formatCents`). La définition
 * (prix unitaires, remises, lignes) se modifie en brouillon ; le serveur
 * repasse tout prix modifié « à valider » (un commercial ne valide jamais un prix).
 */
const c = (v: string | number | null | undefined) => formatCents(v === null || v === undefined ? null : String(v));

export function PricingPanel({ detail, me, onDetail }: { detail: ProposalDetail; me: Me | undefined; onDetail: (d: ProposalDetail) => void }) {
  const toast = useToast();
  const { quote, version, proposal } = detail;
  const def = version.pricingDefinition;
  const canWrite = allows(me, 'proposals.write');
  const draft = proposal.status === 'DRAFT' && !version.lockedAt;
  const configurable = canWrite && (proposal.status === 'DRAFT' || proposal.status === 'READY');
  const canValidate = draft && allows(me, 'proposals.prices.validate');
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});

  useEffect(() => setQty({}), [detail]);

  const select = useMutation({ mutationFn: (b: SelectionBody) => proposalsApi.select(proposal.id, b), onSuccess: onDetail });
  const validate = useMutation({
    mutationFn: (v: PendingValidation) =>
      v.scope === 'SECTION'
        ? proposalsApi.validateSection(proposal.id, v.key)
        : proposalsApi.validatePrice(proposal.id, { scope: v.scope, key: v.key, ...(v.choiceValue !== undefined ? { choiceValue: v.choiceValue } : {}) }),
    onSuccess: (d) => {
      onDetail(d);
      toast.show('Élément validé (tracé dans le journal d’audit).', 'success');
    },
  });

  const optional = def.lines.filter((l) => l.kind === 'OPTIONAL');
  const retained = (l: DefLine) => l.kind !== 'OPTIONAL' || quote.selectedOptions.includes(l.key);
  const adjustable = def.lines.filter((l) => l.quantity && !l.quantity.linkedTo && (l.quantity.max === undefined || l.quantity.max > l.quantity.min) && retained(l));
  const lineStatus = (key: string) => def.lines.find((l) => l.key === key);

  return (
    <section aria-label="Tableau de prix" className="flex flex-col gap-4">
      <ErrorNote>{errorMessage(select.error) ?? errorMessage(validate.error)}</ErrorNote>

      {quote.blockingValidations.length > 0 && (
        <section aria-label="Éléments à valider retenus" className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-13 text-warn">
          <p className="font-button">Prix ou éléments indicatifs (« à valider ») : la proposition ne peut pas passer « prête ».</p>
          <ul className="flex flex-col gap-1">
            {quote.blockingValidations.map((v) => (
              <li key={`${v.scope}:${v.key}:${v.choiceValue ?? ''}`} className="flex flex-wrap items-center gap-2">
                <span>{PRICE_SCOPE_LABELS[v.scope] ?? v.scope} : {v.label}{v.choiceValue ? ` (${v.choiceValue})` : ''}</span>
                {canValidate && (
                  <Button size="sm" variant="warn" disabled={validate.isPending} onClick={() => validate.mutate(v)}>Valider « {v.label} »</Button>
                )}
              </li>
            ))}
          </ul>
          <p>
            Un administrateur valide les prix des modèles : <Link to="/proposal-admin/pending" className="font-button underline">Ouvrir « Prix à valider »</Link>
          </p>
        </section>
      )}

      {configurable ? (
        <fieldset disabled={select.isPending} aria-busy={select.isPending} className="flex flex-col gap-4 rounded-lg border border-line bg-slate-50 p-4">
          <legend className="px-1 text-sm font-title text-ink">Configuration proposée au client</legend>
          {def.choices.map((ch) => (
            <div key={ch.key} role="radiogroup" aria-labelledby={`choix-${ch.key}`} className="flex flex-col gap-2">
              <span id={`choix-${ch.key}`} className="text-xs+ font-button text-ink-muted">{ch.label}</span>
              <div className="flex flex-wrap gap-2">
                {ch.options.map((o) => (
                  <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm">
                    <input type="radio" name={`choix-${ch.key}`} checked={quote.choices[ch.key] === o.value} onChange={() => select.mutate({ choices: { [ch.key]: o.value } })} />
                    {o.label}
                  </label>
                ))}
              </div>
              {!ch.editableByClient && <span className="text-xs text-ink-faint">Non modifiable par le client.</span>}
            </div>
          ))}
          {optional.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs+ font-button text-ink-muted">Options facultatives</span>
              {optional.map((l) => (
                <label key={l.key} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={quote.selectedOptions.includes(l.key)}
                    onChange={(e) => select.mutate({ selectedOptions: e.target.checked ? [...quote.selectedOptions, l.key] : quote.selectedOptions.filter((k) => k !== l.key) })}
                  />
                  {l.label}
                </label>
              ))}
            </div>
          )}
          {adjustable.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {adjustable.map((l) => {
                const id = `qte-${l.key}`;
                const value = qty[l.key] ?? String(quote.quantities[l.key] ?? '');
                const commit = () => {
                  const n = Number(value);
                  if (qty[l.key] === undefined || !Number.isInteger(n) || n < 0 || n === quote.quantities[l.key]) return;
                  select.mutate({ quantities: { [l.key]: n } });
                };
                return (
                  <div key={l.key} className="flex flex-col gap-[5px]">
                    <label htmlFor={id} className="text-xs+ font-button text-ink-muted">Quantité — {l.label}</label>
                    <Input id={id} type="number" inputMode="numeric" step={1} min={l.quantity!.min} {...(l.quantity!.max !== undefined ? { max: l.quantity!.max } : {})}
                      value={value} onChange={(e) => setQty((s) => ({ ...s, [l.key]: e.target.value }))} onBlur={commit}
                      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
                    <span className="text-xs text-ink-faint">
                      <span>Bornes : {l.quantity!.min} à {l.quantity!.max ?? (l.quantity!.maxFrom ? `{{${l.quantity!.maxFrom}}}` : '∞')}</span>
                      {l.quantity!.editableByClient && <span> · modifiable par le client</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>
      ) : (
        <p className="text-13 text-ink-muted">
          {['DRAFT', 'READY'].includes(proposal.status) ? 'Configuration en lecture seule.' : 'Proposition envoyée : la configuration appartient au client (chaque modification est recalculée par le serveur et visible ici).'}
        </p>
      )}

      {quote.errors.length > 0 && (
        <div role="alert" className="rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
          <p className="font-button">Configuration non calculable en l’état :</p>
          <ul className="list-disc pl-5">{quote.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Lignes retenues (montants HT)</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs+ text-ink-muted">
              <th scope="col" className="py-2 pr-3 font-button">Prestation</th>
              <th scope="col" className="py-2 pr-3 font-button">Périodicité</th>
              <th scope="col" className="py-2 pr-3 text-right font-button">Qté</th>
              <th scope="col" className="py-2 pr-3 font-button">Unité</th>
              <th scope="col" className="py-2 pr-3 text-right font-button">Prix unitaire HT</th>
              <th scope="col" className="py-2 pr-3 text-right font-button">Total HT</th>
              <th scope="col" className="py-2 font-button">Prix</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => {
              const special = l.recurrence === 'DISCOUNT' || l.recurrence === 'MINIMUM';
              const src = lineStatus(l.key)?.priceSource;
              return (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{l.label}</td>
                  <td className="py-2 pr-3 text-ink-muted">{RECURRENCE_LABELS[l.recurrence] ?? l.recurrence}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{special ? '' : l.quantity}</td>
                  <td className="py-2 pr-3 text-ink-muted">{special ? '' : l.unit}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{special ? '' : <span>{l.priceFrom ? 'à partir de ' : ''}{c(l.unitPriceCents)}</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums"><span>{c(l.totalHtCents)}</span></td>
                  <td className="py-2">
                    {l.priceStatus === 'TO_VALIDATE' ? <Badge tone="warn">À valider</Badge> : <Badge tone="success">Validé</Badge>}
                    {src && <span className="ml-2 text-xs text-ink-faint">{src}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Totals totals={quote.totals} months={quote.commitmentMonths} />

      {quote.infoLines.length > 0 && (
        <div className="text-13 text-ink-muted">
          <p className="font-button text-ink">Tarifs hors forfait</p>
          <ul className="list-disc pl-5">{quote.infoLines.map((l) => <li key={l.key}>{l.label} — {c(l.unitPriceCents)} HT / {l.unit}</li>)}</ul>
        </div>
      )}

      {draft && canWrite && !editing && (
        <div><Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Modifier les prix</Button></div>
      )}
      {draft && canWrite && editing && <DefinitionEditor def={def} proposalId={proposal.id} onDone={(d) => { setEditing(false); if (d) onDetail(d); }} />}
    </section>
  );
}

function Totals({ totals, months }: { totals: ProposalDetail['quote']['totals']; months: number }) {
  const rows: [string, Bucket, boolean][] = [
    ['Mise en service (ponctuel)', totals.oneTime, false],
    ['Mensuel récurrent', totals.monthly, true],
    ['Trimestriel', totals.quarterly, false],
    ['Prestations annuelles', totals.yearly, false],
    [`Total sur ${months} mois d’engagement (hors mise en service)`, totals.commitment, true],
  ];
  return (
    <ul aria-label="Totaux" className="grid gap-2 rounded-lg border border-line bg-surface p-4 text-sm">
      {rows
        .filter(([, b, always]) => always || String(b.htCents) !== '0')
        .map(([label, b]) => (
          <li key={label} className="grid grid-cols-1 gap-1 border-b border-line pb-2 last:border-0 last:pb-0 sm:grid-cols-[1fr_auto_auto_auto] sm:gap-4">
            <span className="font-button text-ink">{label}</span>
            <span className="tabular-nums">{c(b.htCents)} HT</span>
            <span className="tabular-nums text-ink-muted">{c(b.vatCents)} TVA</span>
            <span className="tabular-nums font-button">{c(b.ttcCents)} TTC</span>
          </li>
        ))}
    </ul>
  );
}

type Draft = Record<string, string>;

/** Édition de la définition : prix unitaires (par formule), remises, ajout d'une ligne. Envoi de la définition COMPLÈTE. */
function DefinitionEditor({ def, proposalId, onDone }: { def: PricingDefinition; proposalId: string; onDone: (d?: ProposalDetail) => void }) {
  const toast = useToast();
  const initial: Draft = {};
  for (const l of def.lines) {
    if ('unitPriceCents' in l.pricing) initial[`line:${l.key}`] = centsToEurosInput(l.pricing.unitPriceCents);
    else for (const [v, cents] of Object.entries(l.pricing.byChoice)) initial[`line:${l.key}:${v}`] = centsToEurosInput(cents);
  }
  for (const r of def.rules) if (r.type === 'DISCOUNT_PERCENT') initial[`rule:${r.key}`] = String(r.percent).replace('.', ',');
  const [values, setValues] = useState<Draft>(initial);
  const [adding, setAdding] = useState(false);
  const [nl, setNl] = useState({ label: '', unit: '', kind: 'REQUIRED', recurrence: 'MONTHLY', price: '', qDefault: '1', qMin: '1', qMax: '', editable: true });
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (next: PricingDefinition) => proposalsApi.putPricing(proposalId, next),
    onSuccess: (d) => {
      toast.show('Tableau de prix enregistré : les prix modifiés sont « à valider ».', 'success');
      onDone(d);
    },
  });

  const build = (): PricingDefinition | string => {
    const cents = (k: string, label: string) => {
      const v = eurosToCents(values[k] ?? '');
      if (v === undefined) throw new Error(`Prix invalide : ${label}.`);
      return v;
    };
    try {
      const lines: DefLine[] = def.lines.map((l) => {
        if ('unitPriceCents' in l.pricing) return { ...l, pricing: { unitPriceCents: cents(`line:${l.key}`, l.label) } };
        const byChoice = Object.fromEntries(Object.keys(l.pricing.byChoice).map((v) => [v, cents(`line:${l.key}:${v}`, `${l.label} (${v})`)]));
        return { ...l, pricing: { dependsOn: l.pricing.dependsOn, byChoice } };
      });
      const rules = def.rules.map((r) => {
        if (r.type !== 'DISCOUNT_PERCENT') return r;
        const p = Number((values[`rule:${r.key}`] ?? '').replace(',', '.'));
        if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error(`Remise invalide : ${String(r.label)}.`);
        return { ...r, percent: p };
      });
      if (adding) {
        if (!nl.label.trim() || !nl.unit.trim()) throw new Error('Nouvelle ligne : libellé et unité obligatoires.');
        const price = eurosToCents(nl.price);
        if (price === undefined) throw new Error('Nouvelle ligne : prix invalide.');
        const min = Number(nl.qMin), dflt = Number(nl.qDefault), max = nl.qMax.trim() ? Number(nl.qMax) : undefined;
        if (![min, dflt].every(Number.isInteger) || (max !== undefined && !Number.isInteger(max))) throw new Error('Nouvelle ligne : quantités entières attendues.');
        const setup = nl.kind === 'SETUP';
        const recurrence = (setup ? 'ONE_TIME' : nl.recurrence) as DefLine['recurrence'];
        const group: DefLine['group'] = setup ? 'SETUP' : nl.kind === 'OPTIONAL' ? 'OPTIONS' : recurrence === 'YEARLY' ? 'YEARLY' : 'RECURRING';
        const taken = new Set(lines.map((l) => l.key));
        let key = nl.label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'ligne';
        for (let n = 2, base = key; taken.has(key); n++) key = `${base}-${n}`;
        lines.push({
          key, label: nl.label.trim(), kind: nl.kind as DefLine['kind'], unit: nl.unit.trim(), recurrence, group,
          quantity: { default: dflt, min, ...(max !== undefined ? { max } : {}), editableByClient: nl.editable },
          pricing: { unitPriceCents: price }, priceStatus: 'TO_VALIDATE', priceSource: 'Saisie commerciale',
        });
      }
      return { ...def, lines, rules };
    } catch (e) {
      return (e as Error).message;
    }
  };

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const field = (id: string, label: string, value: string, onChange: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...extra} />
    </div>
  );

  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <legend className="px-1 text-sm font-title text-ink">Définition du tableau de prix</legend>
      <p className="text-13 text-ink-muted">Tout prix modifié ou ajouté repasse « à valider » : un administrateur devra le valider avant l’envoi.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {def.lines.flatMap((l) =>
          'unitPriceCents' in l.pricing
            ? [field(`prix-${l.key}`, `Prix unitaire HT (€) — ${l.label}`, values[`line:${l.key}`] ?? '', (v) => set(`line:${l.key}`, v), { inputMode: 'decimal' })]
            : Object.keys(l.pricing.byChoice).map((v) => {
                const choice = def.choices.find((ch) => ch.key === (l.pricing as { dependsOn: string }).dependsOn);
                const optLabel = choice?.options.find((o) => o.value === v)?.label ?? v;
                return field(`prix-${l.key}-${v}`, `Prix unitaire HT (€) — ${l.label} (${optLabel})`, values[`line:${l.key}:${v}`] ?? '', (x) => set(`line:${l.key}:${v}`, x), { inputMode: 'decimal' });
              }),
        ).map((el, n) => <div key={n}>{el}</div>)}
        {def.rules.filter((r) => r.type === 'DISCOUNT_PERCENT').map((r) => (
          <div key={r.key}>{field(`remise-${r.key}`, `Remise (%) — ${String(r.label)}`, values[`rule:${r.key}`] ?? '', (v) => set(`rule:${r.key}`, v), { inputMode: 'decimal' })}</div>
        ))}
      </div>

      {!adding ? (
        <div><Button size="sm" variant="ghost" onClick={() => setAdding(true)}>Ajouter une ligne</Button></div>
      ) : (
        <div className="grid gap-3 rounded border border-line bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {field('nl-libelle', 'Libellé de la ligne', nl.label, (v) => setNl({ ...nl, label: v }))}
          {field('nl-unite', 'Unité', nl.unit, (v) => setNl({ ...nl, unit: v }), { placeholder: 'poste / mois' })}
          <div className="flex flex-col gap-[5px]">
            <label htmlFor="nl-type" className="text-xs+ font-button text-ink-muted">Type de ligne</label>
            <Select id="nl-type" value={nl.kind} onChange={(e) => setNl({ ...nl, kind: e.target.value })}>
              <option value="REQUIRED">Obligatoire</option>
              <option value="OPTIONAL">Option facultative</option>
              <option value="SETUP">Mise en service (ponctuel)</option>
            </Select>
          </div>
          {nl.kind !== 'SETUP' && (
            <div className="flex flex-col gap-[5px]">
              <label htmlFor="nl-recurrence" className="text-xs+ font-button text-ink-muted">Récurrence</label>
              <Select id="nl-recurrence" value={nl.recurrence} onChange={(e) => setNl({ ...nl, recurrence: e.target.value })}>
                <option value="MONTHLY">Mensuel</option>
                <option value="QUARTERLY">Trimestriel</option>
                <option value="YEARLY">Annuel</option>
              </Select>
            </div>
          )}
          {field('nl-prix', 'Prix unitaire HT (€)', nl.price, (v) => setNl({ ...nl, price: v }), { inputMode: 'decimal' })}
          {field('nl-qdef', 'Quantité par défaut', nl.qDefault, (v) => setNl({ ...nl, qDefault: v }), { inputMode: 'numeric' })}
          {field('nl-qmin', 'Quantité minimale', nl.qMin, (v) => setNl({ ...nl, qMin: v }), { inputMode: 'numeric' })}
          {field('nl-qmax', 'Quantité maximale', nl.qMax, (v) => setNl({ ...nl, qMax: v }), { inputMode: 'numeric' })}
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={nl.editable} onChange={(e) => setNl({ ...nl, editable: e.target.checked })} /> Quantité modifiable par le client
          </label>
        </div>
      )}

      <ErrorNote>{error ?? errorMessage(save.error)}</ErrorNote>
      <div className="flex gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => {
          const next = build();
          if (typeof next === 'string') { setError(next); return; }
          setError(undefined);
          save.mutate(next);
        }}>{save.isPending ? 'Enregistrement…' : 'Enregistrer les prix'}</Button>
        <Button size="sm" variant="secondary" onClick={() => onDone()}>Annuler</Button>
      </div>
    </fieldset>
  );
}
