import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { useToast } from '../../ui/toast.js';
import { KIND_LABELS, LOOKUP_LABELS, MODE_LABELS, RECURRENCE_LABELS } from './labels.js';
import { draftFromLine, emptyDraft, lineFromDraft, revisionAllowed, type LineDraft } from './line-draft.js';
import type { LineInput, LineKind, PriceIndexRow, PricingMode, PricingRuleRow, Recurrence, ScheduleView } from './types.js';

/**
 * Éditeur d'une version BROUILLON du barème : en-tête (validité, engagement,
 * note) + lignes. Enregistrement = remplacement complet (`PUT …/schedules/{n}`,
 * `UpdateScheduleSchema`). Les erreurs de forme sont signalées avant l'envoi ;
 * le reste (cohérence type × mode, paliers, formules) est jugé par l'API, dont
 * le message est affiché tel quel.
 */

export function useRulesAndIndexes() {
  const rules = useQuery({ queryKey: ['pricing-rules', false], queryFn: () => apiRequest<{ items: PricingRuleRow[] }>('GET', '/v1/pricing-rules') });
  const indexes = useQuery({ queryKey: ['price-indexes'], queryFn: () => apiRequest<{ items: PriceIndexRow[] }>('GET', '/v1/price-indexes') });
  return { rules: rules.data?.items ?? [], indexes: indexes.data?.items ?? [] };
}

const onValue = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => set(e.target.value);

export function ScheduleEditor({ contractId, schedule, onClose }: { contractId: string; schedule: ScheduleView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { rules, indexes } = useRulesAndIndexes();
  const [validFrom, setValidFrom] = useState(schedule.validFrom);
  const [validTo, setValidTo] = useState(schedule.validTo ?? '');
  const [commitment, setCommitment] = useState(schedule.commitmentMonths == null ? '' : String(schedule.commitmentMonths));
  const [note, setNote] = useState(schedule.note ?? '');
  const [drafts, setDrafts] = useState<LineDraft[]>(() => schedule.lines.map((l, i) => draftFromLine(l, i + 1)));
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const title = `Version ${schedule.version} (brouillon) — édition`;
  const datalistId = useId();

  const save = useMutation({
    mutationFn: (body: unknown) => apiRequest<ScheduleView>('PUT', `/v1/contracts/${contractId}/pricing/schedules/${schedule.version}`, body),
    onSuccess: () => {
      toast.show(`Version ${schedule.version} enregistrée.`, 'success');
      void qc.invalidateQueries({ queryKey: ['pricing-schedules', contractId] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errors: string[] = [];
    if (!validFrom) errors.push('Date de début de validité obligatoire.');
    let commitmentMonths: number | null = null;
    if (commitment.trim()) {
      const n = Number(commitment.trim());
      if (!Number.isInteger(n) || n < 1 || n > 240) errors.push('Engagement : nombre entier de mois entre 1 et 240.');
      else commitmentMonths = n;
    }
    const lines: LineInput[] = [];
    for (const d of drafts) {
      const r = lineFromDraft(d);
      if ('errors' in r) errors.push(...r.errors);
      else lines.push(r.line);
    }
    setFormErrors(errors);
    if (errors.length) return;
    save.mutate({ validFrom, validTo: validTo || null, commitmentMonths, note: note.trim() || null, lines });
  }

  const update = (i: number, patch: Partial<LineDraft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => setDrafts((ds) => ds.filter((_, j) => j !== i));
  const move = (i: number, delta: -1 | 1) =>
    setDrafts((ds) => {
      const j = i + delta;
      if (j < 0 || j >= ds.length) return ds;
      const next = [...ds];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <RegionCard title={title} actions={<Button type="button" variant="secondary" size="sm" onClick={onClose}>Fermer l’éditeur</Button>}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Valide à partir du" htmlFor={`${datalistId}-from`}>
            <Input id={`${datalistId}-from`} type="date" value={validFrom} onChange={onValue(setValidFrom)} required />
          </Field>
          <Field label="Jusqu’au (inclus, vide = sans fin)" htmlFor={`${datalistId}-to`}>
            <Input id={`${datalistId}-to`} type="date" value={validTo} onChange={onValue(setValidTo)} />
          </Field>
          <Field label="Engagement (mois)" htmlFor={`${datalistId}-commit`} hint="Sert aux remises d’engagement.">
            <Input id={`${datalistId}-commit`} inputMode="numeric" value={commitment} onChange={onValue(setCommitment)} />
          </Field>
          <Field label="Note" htmlFor={`${datalistId}-note`}>
            <Input id={`${datalistId}-note`} value={note} onChange={onValue(setNote)} />
          </Field>
        </div>
        <datalist id={`${datalistId}-indexes`}>
          {indexes.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
        </datalist>
        {drafts.length === 0 && <p className="text-sm text-ink-faint">Aucune ligne : une version vide ne peut pas être activée.</p>}
        {drafts.map((d, i) => (
          <LineEditor
            key={i}
            index={i}
            draft={d}
            count={drafts.length}
            otherKeys={drafts.filter((_, j) => j !== i && drafts[j]!.kind !== 'DISCOUNT').map((x) => ({ key: x.lineKey, label: x.label }))}
            rules={rules}
            indexListId={`${datalistId}-indexes`}
            onChange={(p) => update(i, p)}
            onRemove={() => remove(i)}
            onMove={(delta) => move(i, delta)}
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => setDrafts((ds) => [...ds, emptyDraft(ds.length + 1)])}>Ajouter une ligne</Button>
          <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Enregistrement…' : 'Enregistrer le brouillon'}</Button>
        </div>
        {formErrors.length > 0 && (
          <div role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">
            <p className="font-medium">Corriger avant d’enregistrer :</p>
            <ul className="list-disc pl-5">{formErrors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        <ErrorNote>{errorText(save.error)}</ErrorNote>
      </form>
    </RegionCard>
  );
}

// ---------------------------------------------------------------------------
// Ligne
// ---------------------------------------------------------------------------

const KINDS = Object.keys(KIND_LABELS) as LineKind[];
const MODES = Object.keys(MODE_LABELS) as PricingMode[];
const RECURRENCES = Object.keys(RECURRENCE_LABELS) as Recurrence[];

function LineEditor({
  index, draft: d, count, otherKeys, rules, indexListId, onChange, onRemove, onMove,
}: {
  index: number;
  draft: LineDraft;
  count: number;
  otherKeys: Array<{ key: string; label: string }>;
  rules: PricingRuleRow[];
  indexListId: string;
  onChange: (p: Partial<LineDraft>) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const uid = useId();
  const id = (f: string) => `${uid}-${f}`;
  const set = (k: keyof LineDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ [k]: e.target.value } as Partial<LineDraft>);
  const isDiscount = d.kind === 'DISCOUNT';
  const mode: PricingMode = isDiscount ? 'MANUAL' : d.mode;
  const legend = `Ligne ${index + 1}${d.label.trim() ? ` — ${d.label.trim()}` : ''}`;
  const priceRules = rules.filter((r) => !r.archivedAt && (d.kind === 'TIERED' ? r.type === 'TIERS' : r.type === 'GRID'));
  const adjustRules = rules.filter((r) => !r.archivedAt && (r.type === 'VOLUME_DISCOUNT' || r.type === 'COMMITMENT_DISCOUNT'));

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <legend className="px-1 text-sm font-title text-ink">{legend}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Clé de ligne" htmlFor={id('key')} hint="Stable d’une version à l’autre.">
          <Input id={id('key')} value={d.lineKey} onChange={set('lineKey')} />
        </Field>
        <Field label="Code article" htmlFor={id('article')}>
          <Input id={id('article')} value={d.articleCode} onChange={set('articleCode')} />
        </Field>
        <Field label="Libellé" htmlFor={id('label')}>
          <Input id={id('label')} value={d.label} onChange={set('label')} />
        </Field>
        <Field label="Unité" htmlFor={id('unit')}>
          <Input id={id('unit')} value={d.unit} onChange={set('unit')} />
        </Field>
        <Field label="Type de ligne" htmlFor={id('kind')}>
          <Select id={id('kind')} value={d.kind} onChange={set('kind')}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </Select>
        </Field>
        {!isDiscount && (
          <Field label="Mode de prix" htmlFor={id('mode')}>
            <Select id={id('mode')} value={d.mode} onChange={set('mode')}>
              {MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Récurrence" htmlFor={id('rec')} hint="Défaut selon le type ; imposée pour les forfaits et frais de mise en service.">
          <Select id={id('rec')} value={d.recurrence} onChange={set('recurrence')}>
            <option value="">(par défaut)</option>
            {RECURRENCES.map((r) => <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>)}
          </Select>
        </Field>
        <Field label="Taux de TVA (%)" htmlFor={id('vat')}>
          <Input id={id('vat')} inputMode="decimal" value={d.vatRatePercent} onChange={set('vatRatePercent')} />
        </Field>
      </div>

      {!isDiscount && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Source de la quantité" htmlFor={id('qsrc')}>
            <Select id={id('qsrc')} value={d.quantitySource} onChange={set('quantitySource')}>
              <option value="FIXED">Saisie au barème</option>
              <option value="PROVIDER">Fournie par une application (RMM…)</option>
            </Select>
          </Field>
          {d.quantitySource === 'FIXED' ? (
            <Field label="Quantité" htmlFor={id('qty')}>
              <Input id={id('qty')} inputMode="decimal" value={d.quantity} onChange={set('quantity')} />
            </Field>
          ) : (
            <Field label="Article du fournisseur de quantités" htmlFor={id('prov')}>
              <Input id={id('prov')} value={d.providerArticleCode} onChange={set('providerArticleCode')} />
            </Field>
          )}
          {d.kind === 'HOUR_PACK' && (
            <Field label="Heures par pack" htmlFor={id('hpp')}>
              <Input id={id('hpp')} inputMode="decimal" value={d.hoursPerPack} onChange={set('hoursPerPack')} />
            </Field>
          )}
        </div>
      )}

      {isDiscount && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Type de remise" htmlFor={id('dtype')}>
            <Select id={id('dtype')} value={d.discountType} onChange={set('discountType')}>
              <option value="PERCENT">Pourcentage</option>
              <option value="AMOUNT">Montant (€ HT)</option>
            </Select>
          </Field>
          <Field label={d.discountType === 'PERCENT' ? 'Valeur de la remise (%)' : 'Valeur de la remise (€)'} htmlFor={id('dval')}>
            <Input id={id('dval')} inputMode="decimal" value={d.discountValue} onChange={set('discountValue')} />
          </Field>
          <Field label="Porte sur" htmlFor={id('dscope')} hint="Cibles de même taux de TVA et de même récurrence.">
            <Select id={id('dscope')} value={d.discountScope} onChange={set('discountScope')}>
              <option value="SUBTOTAL">Le sous-total</option>
              <option value="LINES">Des lignes désignées</option>
            </Select>
          </Field>
          {d.discountScope === 'LINES' && (
            <div role="group" aria-label="Lignes remisées" className="flex flex-wrap gap-3 sm:col-span-3">
              {otherKeys.length === 0 && <span className="text-13 text-ink-faint">Aucune autre ligne.</span>}
              {otherKeys.map((o) => (
                <label key={o.key} className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={d.discountLineIds.includes(o.key)}
                    onChange={(e) => onChange({
                      discountLineIds: e.target.checked ? [...d.discountLineIds, o.key] : d.discountLineIds.filter((k) => k !== o.key),
                    })}
                  />
                  {o.label || o.key}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {!isDiscount && mode === 'MANUAL' && d.kind !== 'TIERED' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Prix unitaire HT (€)" htmlFor={id('price')}>
            <Input id={id('price')} inputMode="decimal" value={d.unitPrice} onChange={set('unitPrice')} />
          </Field>
        </div>
      )}

      {!isDiscount && mode === 'MANUAL' && d.kind === 'TIERED' && (
        <TiersEditor
          uid={uid}
          mode={d.tierMode}
          tiers={d.tiers}
          onMode={(tierMode) => onChange({ tierMode })}
          onTiers={(tiers) => onChange({ tiers })}
        />
      )}

      {!isDiscount && mode === 'RULE' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Règle de prix" htmlFor={id('rule')} hint={d.kind === 'TIERED' ? 'Règle de paliers (TIERS).' : 'Grille par code article (GRID).'}>
            <Select id={id('rule')} value={d.priceRuleId} onChange={set('priceRuleId')}>
              <option value="">(choisir)</option>
              {d.priceRuleId && !priceRules.some((r) => r.code === d.priceRuleId) && <option value={d.priceRuleId}>{d.priceRuleId}</option>}
              {priceRules.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.label}</option>)}
            </Select>
          </Field>
          <div role="group" aria-label="Ajustements (remises en cascade)" className="flex flex-col gap-1">
            <span className="text-xs+ font-button text-ink-muted">Ajustements (remises en cascade)</span>
            {adjustRules.length === 0 && <span className="text-13 text-ink-faint">Aucune règle de remise au catalogue.</span>}
            {adjustRules.map((r) => (
              <label key={r.code} className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={d.adjustmentRuleIds.includes(r.code)}
                  onChange={(e) => onChange({
                    adjustmentRuleIds: e.target.checked ? [...d.adjustmentRuleIds, r.code] : d.adjustmentRuleIds.filter((c) => c !== r.code),
                  })}
                />
                {r.code} — {r.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {!isDiscount && mode === 'FORMULA' && (
        <FormulaEditor uid={uid} draft={d} indexListId={indexListId} onChange={onChange} />
      )}

      {revisionAllowed({ kind: d.kind, mode }) && (
        <div className="flex flex-col gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.hasRevision} onChange={(e) => onChange({ hasRevision: e.target.checked })} />
            Révision indicielle native — P1 = P0 × (a + b × S1 / S0)
          </label>
          {d.hasRevision && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Indice" htmlFor={id('ridx')}>
                <Input id={id('ridx')} list={indexListId} value={d.revIndexCode} onChange={set('revIndexCode')} />
              </Field>
              <Field label="Coefficient a (part fixe)" htmlFor={id('ra')}>
                <Input id={id('ra')} inputMode="decimal" value={d.revA} onChange={set('revA')} />
              </Field>
              <Field label="Coefficient b (part indexée)" htmlFor={id('rb')} hint="a + b = 1.">
                <Input id={id('rb')} inputMode="decimal" value={d.revB} onChange={set('revB')} />
              </Field>
              <Field label="Date de référence (S0)" htmlFor={id('rref')}>
                <Input id={id('rref')} type="date" value={d.revReferenceDate} onChange={set('revReferenceDate')} />
              </Field>
              <Field label="Date de révision (S1)" htmlFor={id('rrev')}>
                <Input id={id('rrev')} type="date" value={d.revRevisionDate} onChange={set('revRevisionDate')} />
              </Field>
              <Field label="Recherche de la valeur d’indice" htmlFor={id('rlook')}>
                <Select id={id('rlook')} value={d.revLookup} onChange={set('revLookup')}>
                  <option value="">(paramètre du tenant)</option>
                  {Object.entries(LOOKUP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>Monter</Button>
        <Button type="button" variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>Descendre</Button>
        <Button type="button" variant="danger-ghost" size="sm" onClick={onRemove}>Retirer la ligne {index + 1}</Button>
      </div>
    </fieldset>
  );
}

function TiersEditor({
  uid, mode, tiers, onMode, onTiers,
}: {
  uid: string;
  mode: LineDraft['tierMode'];
  tiers: LineDraft['tiers'];
  onMode: (m: LineDraft['tierMode']) => void;
  onTiers: (t: LineDraft['tiers']) => void;
}) {
  const setTier = (i: number, patch: Partial<LineDraft['tiers'][number]>) => onTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="flex flex-col gap-2">
      <Field label="Mode des paliers" htmlFor={`${uid}-tmode`} hint="Par tranches : chaque unité au prix de sa tranche. Au volume : toute la quantité au prix du palier atteint.">
        <Select id={`${uid}-tmode`} value={mode} onChange={(e) => onMode(e.target.value as LineDraft['tierMode'])}>
          <option value="GRADUATED">Par tranches</option>
          <option value="VOLUME">Au volume (palier atteint)</option>
        </Select>
      </Field>
      {tiers.map((t, i) => (
        <div key={i} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label={`Borne haute du palier ${i + 1}`} htmlFor={`${uid}-up-${i}`} hint={i === tiers.length - 1 ? 'Vide = illimité (dernier palier).' : undefined}>
            <Input id={`${uid}-up-${i}`} inputMode="decimal" value={t.upTo} onChange={(e) => setTier(i, { upTo: e.target.value })} />
          </Field>
          <Field label={`Prix unitaire du palier ${i + 1}`} htmlFor={`${uid}-tp-${i}`}>
            <Input id={`${uid}-tp-${i}`} inputMode="decimal" value={t.unitPrice} onChange={(e) => setTier(i, { unitPrice: e.target.value })} />
          </Field>
          <Button type="button" variant="danger-ghost" size="sm" disabled={tiers.length === 1} onClick={() => onTiers(tiers.filter((_, j) => j !== i))}>
            Supprimer le palier {i + 1}
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onTiers([...tiers, { upTo: '', unitPrice: '' }])}>Ajouter un palier</Button>
      </div>
    </div>
  );
}

function FormulaEditor({ uid, draft: d, indexListId, onChange }: { uid: string; draft: LineDraft; indexListId: string; onChange: (p: Partial<LineDraft>) => void }) {
  const setVar = (i: number, patch: Partial<LineDraft['variables'][number]>) =>
    onChange({ variables: d.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const setIdx = (i: number, patch: Partial<LineDraft['indexVariables'][number]>) =>
    onChange({ indexVariables: d.indexVariables.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Expression" htmlFor={`${uid}-expr`} hint="Résultat = prix unitaire HT. Variables : qty, P0 (prix de base), constantes et indices ci-dessous. Fonctions : min, max, round, floor, ceil, abs, if. Ex. P0 * (0.15 + 0.85 * S1 / S0).">
        <textarea id={`${uid}-expr`} rows={2} className={controlClass} value={d.expression} onChange={(e) => onChange({ expression: e.target.value })} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Prix de base (€)" htmlFor={`${uid}-base`} hint="Variable P0.">
          <Input id={`${uid}-base`} inputMode="decimal" value={d.basePrice} onChange={(e) => onChange({ basePrice: e.target.value })} />
        </Field>
      </div>
      {d.variables.map((v, i) => (
        <div key={`v${i}`} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label={`Nom de la variable ${i + 1}`} htmlFor={`${uid}-vn-${i}`}>
            <Input id={`${uid}-vn-${i}`} value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
          </Field>
          <Field label={`Valeur de la variable ${i + 1}`} htmlFor={`${uid}-vv-${i}`}>
            <Input id={`${uid}-vv-${i}`} inputMode="decimal" value={v.value} onChange={(e) => setVar(i, { value: e.target.value })} />
          </Field>
          <Button type="button" variant="danger-ghost" size="sm" onClick={() => onChange({ variables: d.variables.filter((_, j) => j !== i) })}>
            Retirer la variable {i + 1}
          </Button>
        </div>
      ))}
      {d.indexVariables.map((v, i) => (
        <div key={`i${i}`} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <Field label={`Variable d’indice ${i + 1}`} htmlFor={`${uid}-in-${i}`}>
            <Input id={`${uid}-in-${i}`} value={v.name} onChange={(e) => setIdx(i, { name: e.target.value })} />
          </Field>
          <Field label={`Indice de la variable ${i + 1}`} htmlFor={`${uid}-ic-${i}`}>
            <Input id={`${uid}-ic-${i}`} list={indexListId} value={v.indexCode} onChange={(e) => setIdx(i, { indexCode: e.target.value })} />
          </Field>
          <Field label={`Date de la variable ${i + 1}`} htmlFor={`${uid}-id-${i}`} hint="AAAA-MM-JJ ou PRICING_DATE (date du calcul).">
            <Input id={`${uid}-id-${i}`} value={v.date} onChange={(e) => setIdx(i, { date: e.target.value })} />
          </Field>
          <Field label={`Recherche de la variable ${i + 1}`} htmlFor={`${uid}-il-${i}`}>
            <Select id={`${uid}-il-${i}`} value={v.lookup} onChange={(e) => setIdx(i, { lookup: e.target.value as LineDraft['revLookup'] })}>
              <option value="">(paramètre du tenant)</option>
              {Object.entries(LOOKUP_LABELS).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
            </Select>
          </Field>
          <Button type="button" variant="danger-ghost" size="sm" onClick={() => onChange({ indexVariables: d.indexVariables.filter((_, j) => j !== i) })}>
            Retirer la variable d’indice {i + 1}
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ variables: [...d.variables, { name: '', value: '' }] })}>Ajouter une variable</Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange({ indexVariables: [...d.indexVariables, { name: '', indexCode: '', date: 'PRICING_DATE', lookup: '' }] })}
        >
          Ajouter une variable d’indice
        </Button>
      </div>
    </div>
  );
}
