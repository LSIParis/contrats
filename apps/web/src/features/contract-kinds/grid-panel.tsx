import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, errorText } from '../../lib/api.js';
import { decimalFromInput, decimalToInput, formatDecimal } from '../../lib/money.js';
import { Badge } from '../../ui/badge.js';
import { Button, buttonClass } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { contractKindsApi, type ItemInput } from './api.js';
import { euros, fmtDay, GRID_RECURRENCES, PRICE_UNITS, recurrenceLabel, todayIso, unitLabel } from './labels.js';
import type { CommitmentTermRow, ContractKindRow, DurationPrice, GridItem, GridRecurrence, GridVariant, ImportReport, PriceUnitCode } from './types.js';

/**
 * Grille tarifaire d'un type : une ligne par code de base, une colonne par
 * durée d'engagement active. Les codes sont attribués par la base et jamais
 * réutilisés ; un changement de prix crée un nouveau prix daté (historique
 * conservé), il n'écrase rien.
 */
export const gridKey = (kindId: string) => ['contract-kind-grid', kindId] as const;

const activeVariant = (item: GridItem, months: number): GridVariant | undefined =>
  item.variants.find((v) => v.months === months && !v.archivedAt);

function useRefreshGrid(kindId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: gridKey(kindId) });
    void qc.invalidateQueries({ queryKey: ['price-grid-history'] });
    void qc.invalidateQueries({ queryKey: ['contract-kinds'] });
    void qc.invalidateQueries({ queryKey: ['contract-kind', kindId] });
  };
}

export function GridPanel({ kind, canManage }: { kind: ContractKindRow; canManage: boolean }) {
  const uid = useId();
  const toast = useToast();
  const refresh = useRefreshGrid(kind.id);
  const [on, setOn] = useState(todayIso);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pricing, setPricing] = useState<GridItem | null>(null);
  const [editing, setEditing] = useState<GridItem | null>(null);
  const [toggling, setToggling] = useState<GridItem | null>(null);
  const q = useQuery({
    queryKey: [...gridKey(kind.id), on, archived],
    queryFn: () => contractKindsApi.grid(kind.id, on, archived),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(on),
  });
  const toggle = useMutation({
    mutationFn: (i: GridItem) => contractKindsApi.setItemArchived(i.code, !i.archivedAt),
    onSuccess: (i) => {
      toast.show(`Code ${i.code} ${i.archivedAt ? 'archivé' : 'désarchivé'}.`, 'success');
      setToggling(null);
      refresh();
    },
  });
  const terms = q.data?.terms ?? [];
  const items = q.data?.items ?? [];
  return (
    <RegionCard
      title="Grille tarifaire"
      actions={
        <span className="inline-flex flex-wrap gap-2">
          <a className={buttonClass('secondary', 'sm')} href={contractKindsApi.csvUrl(kind.id)}>Exporter CSV</a>
          {canManage && <Button type="button" size="sm" variant="secondary" onClick={() => setImporting(true)}>Importer CSV</Button>}
          {canManage && <Button type="button" size="sm" onClick={() => setCreating(true)}>Nouveau code</Button>}
        </span>
      }
    >
      <p className="text-13 text-ink-muted">
        Les codes ({kind.prefix}-0001, {kind.prefix}-0002…) sont attribués automatiquement et jamais réutilisés ; chaque durée en donne une
        version ({kind.prefix}-0001-E12). Modifier un prix crée un nouveau prix daté : l’historique est conservé et les documents déjà émis ne changent pas.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-[5px]">
          <label htmlFor={`${uid}-on`} className="text-xs+ font-button text-ink-muted">Prix en vigueur au</label>
          <Input id={`${uid}-on`} type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </div>
        <label className="inline-flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Afficher les codes archivés
        </label>
      </div>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucun code dans cette grille.</p>}
      {items.length > 0 && (
        <Table
          caption={`Grille tarifaire ${kind.label}`}
          head={
            <tr>
              <th>Code</th><th>Libellé</th><th>Unité</th><th>Périodicité</th><th>TVA</th>
              {terms.map((t) => <th key={t.id} className="!text-right">{t.label}</th>)}
              {canManage && <th>Actions</th>}
            </tr>
          }
        >
          {items.map((i) => (
            <tr key={i.id}>
              <td className="whitespace-nowrap font-mono">
                {i.code}
                {i.archivedAt && <span className="ml-1.5"><Badge tone="muted">Archivé</Badge></span>}
              </td>
              <td>{i.label}{i.description && <span className="block text-xs text-ink-faint">{i.description}</span>}</td>
              <td>{unitLabel(i.unit)}</td>
              <td>{recurrenceLabel(i.recurrence)}</td>
              <td className="tabular-nums">{formatDecimal(i.vatRatePercent, { minFraction: 0 })} %</td>
              {terms.map((t) => <PriceCell key={t.id} variant={activeVariant(i, t.months)} />)}
              {canManage && (
                <td>
                  <span className="inline-flex flex-wrap gap-1.5">
                    {!i.archivedAt && (
                      <Button type="button" size="sm" variant="ghost" aria-label={`Modifier les prix de ${i.code}`} onClick={() => setPricing(i)}>Modifier les prix</Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" aria-label={`Modifier ${i.code}`} onClick={() => setEditing(i)}>Modifier</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={i.archivedAt ? 'ghost' : 'danger-ghost'}
                      aria-label={`${i.archivedAt ? 'Désarchiver' : 'Archiver'} ${i.code}`}
                      onClick={() => { toggle.reset(); setToggling(i); }}
                    >
                      {i.archivedAt ? 'Désarchiver' : 'Archiver'}
                    </Button>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
      <ConfirmDialog
        open={toggling !== null}
        title={`${toggling?.archivedAt ? 'Désarchiver' : 'Archiver'} le code ${toggling?.code ?? ''}`}
        confirmLabel={toggling?.archivedAt ? 'Désarchiver' : 'Archiver'}
        variant={toggling?.archivedAt ? 'primary' : 'danger'}
        onConfirm={() => toggling && toggle.mutate(toggling)}
        onClose={() => setToggling(null)}
        pending={toggle.isPending}
        error={errorText(toggle.error)}
      >
        <p>
          {toggling?.archivedAt
            ? 'Le code et ses versions redeviennent sélectionnables dans les documents.'
            : 'Le code n’est plus proposé dans les documents ; son numéro reste réservé et ne sera jamais réattribué.'}
        </p>
      </ConfirmDialog>
      {creating && <CreateItemDialog kind={kind} terms={terms} onClose={() => setCreating(false)} />}
      {pricing && <PricesDialog kindId={kind.id} item={pricing} terms={terms} onClose={() => setPricing(null)} />}
      {editing && <EditItemDialog kindId={kind.id} item={editing} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog kind={kind} terms={terms} onClose={() => setImporting(false)} />}
    </RegionCard>
  );
}

function PriceCell({ variant }: { variant: GridVariant | undefined }) {
  const up = variant?.upcoming;
  return (
    <td className="text-right tabular-nums">
      {variant?.unitPrice ? (
        <>
          <span className="whitespace-nowrap">{euros(variant.unitPrice)}</span>
          {variant.purchasePrice && <span className="block whitespace-nowrap text-xs text-ink-faint">achat {euros(variant.purchasePrice)}</span>}
        </>
      ) : (
        <span className="text-ink-faint" title="Non proposée pour cette durée">—</span>
      )}
      {up && <span className="block whitespace-nowrap text-xs text-info">→ {euros(up.unitPrice)} au {fmtDay(up.effectiveFrom)}</span>}
    </td>
  );
}

// --- Saisie des prix par durée -------------------------------------------------

type PriceRow = { unit: string; purchase: string };

function PriceInputs({ uid, terms, rows, onChange }: {
  uid: string; terms: CommitmentTermRow[]; rows: Record<number, PriceRow>; onChange: (months: number, p: Partial<PriceRow>) => void;
}) {
  if (terms.length === 0) return <p className="text-13 text-ink-faint">Aucune durée d’engagement active : en créer une dans « Types de contrats › Durées d’engagement ».</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs+ font-button text-ink-muted">Prix HT par durée (vide = non proposée)</legend>
      {terms.map((t) => (
        <div key={t.id} className="grid grid-cols-2 gap-2">
          <Field label={`Prix de vente — ${t.label}`} htmlFor={`${uid}-u-${t.months}`}>
            <Input id={`${uid}-u-${t.months}`} inputMode="decimal" value={rows[t.months]?.unit ?? ''} onChange={(e) => onChange(t.months, { unit: e.target.value })} />
          </Field>
          <Field label={`Prix d’achat — ${t.label}`} htmlFor={`${uid}-p-${t.months}`}>
            <Input id={`${uid}-p-${t.months}`} inputMode="decimal" value={rows[t.months]?.purchase ?? ''} onChange={(e) => onChange(t.months, { purchase: e.target.value })} />
          </Field>
        </div>
      ))}
    </fieldset>
  );
}

function usePriceRows(init: () => Record<number, PriceRow>) {
  const [rows, setRows] = useState(init);
  const set = (months: number, p: Partial<PriceRow>) =>
    setRows((r) => ({ ...r, [months]: { unit: r[months]?.unit ?? '', purchase: r[months]?.purchase ?? '', ...p } }));
  return [rows, set] as const;
}

const sameDecimal = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Number(a) === Number(b));

/** Valide une saisie de prix : chaîne API, null (vide) ou erreur. */
function parsePrice(v: string, what: string): { value: string | null } | { error: string } {
  const d = decimalFromInput(v);
  if (d === undefined) return { value: null };
  if (d === null) return { error: `${what} : montant invalide (nombre positif, 6 décimales au plus).` };
  return { value: d };
}

function ItemFields({ uid, f, setF }: { uid: string; f: ItemForm; setF: (p: Partial<ItemForm>) => void }) {
  return (
    <>
      <Field label="Libellé" htmlFor={`${uid}-label`}>
        <Input id={`${uid}-label`} value={f.label} onChange={(e) => setF({ label: e.target.value })} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`}>
        <Input id={`${uid}-desc`} value={f.description} onChange={(e) => setF({ description: e.target.value })} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Unité" htmlFor={`${uid}-unit`}>
          <Select id={`${uid}-unit`} value={f.unit} onChange={(e) => setF({ unit: e.target.value as PriceUnitCode })}>
            {PRICE_UNITS.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
          </Select>
        </Field>
        <Field label="Périodicité" htmlFor={`${uid}-rec`}>
          <Select id={`${uid}-rec`} value={f.recurrence} onChange={(e) => setF({ recurrence: e.target.value as GridRecurrence })}>
            {GRID_RECURRENCES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="TVA (%)" htmlFor={`${uid}-vat`}>
          <Input id={`${uid}-vat`} inputMode="decimal" value={f.vat} onChange={(e) => setF({ vat: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

type ItemForm = { label: string; description: string; unit: PriceUnitCode; recurrence: GridRecurrence; vat: string };

function CreateItemDialog({ kind, terms, onClose }: { kind: ContractKindRow; terms: CommitmentTermRow[]; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const refresh = useRefreshGrid(kind.id);
  const [f, setForm] = useState<ItemForm>({ label: '', description: '', unit: 'PER_USER', recurrence: 'MONTHLY', vat: '20' });
  const setF = (p: Partial<ItemForm>) => setForm((x) => ({ ...x, ...p }));
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso);
  const [rows, setRow] = usePriceRows(() => ({}));
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (b: Parameters<typeof contractKindsApi.createItem>[1]) => contractKindsApi.createItem(kind.id, b),
    onSuccess: (i) => {
      toast.show(`Code ${i.code} créé.`, 'success');
      refresh();
      onClose();
    },
  });
  function submit() {
    const vat = decimalFromInput(f.vat, { maxFraction: 2 });
    if (!vat) return setFormError('TVA : pourcentage invalide.');
    const prices: DurationPrice[] = [];
    for (const t of terms) {
      const r = rows[t.months];
      const u = parsePrice(r?.unit ?? '', `Prix de vente ${t.label}`);
      if ('error' in u) return setFormError(u.error);
      const p = parsePrice(r?.purchase ?? '', `Prix d’achat ${t.label}`);
      if ('error' in p) return setFormError(p.error);
      if (u.value === null) {
        if (p.value !== null) return setFormError(`${t.label} : un prix d’achat exige un prix de vente.`);
        continue;
      }
      prices.push({ months: t.months, unitPrice: u.value, ...(p.value !== null ? { purchasePrice: p.value } : {}) });
    }
    setFormError(undefined);
    m.mutate({
      label: f.label.trim(),
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
      unit: f.unit, recurrence: f.recurrence, vatRatePercent: vat,
      ...(effectiveFrom ? { effectiveFrom } : {}),
      ...(prices.length ? { prices } : {}),
    });
  }
  return (
    <ConfirmDialog
      open
      title={`Nouveau code — ${kind.label}`}
      confirmLabel="Créer le code"
      disabled={!f.label.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <p className="text-13 text-ink-muted">Le code ({kind.prefix}-NNNN) est attribué automatiquement à la création.</p>
      <ItemFields uid={uid} f={f} setF={setF} />
      <Field label="Date d’effet des prix" htmlFor={`${uid}-eff`}>
        <Input id={`${uid}-eff`} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </Field>
      <PriceInputs uid={uid} terms={terms} rows={rows} onChange={setRow} />
    </ConfirmDialog>
  );
}

/**
 * Nouveaux prix datés d'un code : seules les durées modifiées sont envoyées ;
 * un prix de vente vidé retire la durée (`unitPrice: null`).
 */
function PricesDialog({ kindId, item, terms, onClose }: { kindId: string; item: GridItem; terms: CommitmentTermRow[]; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const refresh = useRefreshGrid(kindId);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso);
  const initial = (months: number) => {
    const v = activeVariant(item, months);
    return { unit: v?.unitPrice ?? null, purchase: v?.unitPrice ? v.purchasePrice : null };
  };
  const [rows, setRow] = usePriceRows(() =>
    Object.fromEntries(terms.map((t) => {
      const i = initial(t.months);
      return [t.months, { unit: decimalToInput(i.unit), purchase: decimalToInput(i.purchase) }];
    })),
  );
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (b: { effectiveFrom?: string; prices: DurationPrice[] }) => contractKindsApi.setPrices(item.code, b),
    onSuccess: () => {
      toast.show(`Prix de ${item.code} enregistrés.`, 'success');
      refresh();
      onClose();
    },
  });
  function submit() {
    const prices: DurationPrice[] = [];
    for (const t of terms) {
      const r = rows[t.months];
      const u = parsePrice(r?.unit ?? '', `Prix de vente ${t.label}`);
      if ('error' in u) return setFormError(u.error);
      const p = parsePrice(r?.purchase ?? '', `Prix d’achat ${t.label}`);
      if ('error' in p) return setFormError(p.error);
      const init = initial(t.months);
      if (u.value === null) {
        if (init.unit !== null) prices.push({ months: t.months, unitPrice: null });
        continue;
      }
      if (!sameDecimal(u.value, init.unit) || !sameDecimal(p.value, init.purchase)) {
        prices.push({ months: t.months, unitPrice: u.value, purchasePrice: p.value });
      }
    }
    if (prices.length === 0) return setFormError('Aucun prix modifié.');
    setFormError(undefined);
    m.mutate({ ...(effectiveFrom ? { effectiveFrom } : {}), prices });
  }
  return (
    <ConfirmDialog
      open
      title={`Modifier les prix de ${item.code}`}
      confirmLabel="Enregistrer les prix"
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <p className="text-13 text-ink-muted">
        {item.label}. Un nouveau prix daté est créé pour chaque durée modifiée ; les anciens prix restent dans l’historique.
        Vider un prix de vente retire la durée (version non proposée) ; les durées non modifiées ne changent pas.
      </p>
      <Field label="Date d’effet" htmlFor={`${uid}-eff`}>
        <Input id={`${uid}-eff`} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </Field>
      <PriceInputs uid={uid} terms={terms} rows={rows} onChange={setRow} />
    </ConfirmDialog>
  );
}

function EditItemDialog({ kindId, item, onClose }: { kindId: string; item: GridItem; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const refresh = useRefreshGrid(kindId);
  const [f, setForm] = useState<ItemForm>({
    label: item.label, description: item.description ?? '', unit: item.unit, recurrence: item.recurrence, vat: decimalToInput(item.vatRatePercent),
  });
  const setF = (p: Partial<ItemForm>) => setForm((x) => ({ ...x, ...p }));
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (b: ItemInput) => contractKindsApi.updateItem(item.code, b),
    onSuccess: () => {
      toast.show(`Code ${item.code} modifié.`, 'success');
      refresh();
      onClose();
    },
  });
  function submit() {
    const vat = decimalFromInput(f.vat, { maxFraction: 2 });
    if (!vat) return setFormError('TVA : pourcentage invalide.');
    const b: ItemInput = {};
    if (f.label.trim() !== item.label) b.label = f.label.trim();
    if (f.description.trim() !== (item.description ?? '')) b.description = f.description.trim() || null;
    if (f.unit !== item.unit) b.unit = f.unit;
    if (f.recurrence !== item.recurrence) b.recurrence = f.recurrence;
    if (!sameDecimal(vat, item.vatRatePercent)) b.vatRatePercent = vat;
    if (Object.keys(b).length === 0) return onClose();
    setFormError(undefined);
    m.mutate(b);
  }
  return (
    <ConfirmDialog
      open
      title={`Modifier ${item.code}`}
      confirmLabel="Enregistrer"
      disabled={!f.label.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <ItemFields uid={uid} f={f} setF={setF} />
    </ConfirmDialog>
  );
}

// --- Import CSV ------------------------------------------------------------------

export function importSummary(r: ImportReport): string {
  return `${r.created.length} code(s) créé(s), ${r.updated.length} mis à jour, ${r.pricesAdded} prix ajouté(s), ${r.variantsWithdrawn} durée(s) retirée(s)`;
}

function ImportDialog({ kind, terms, onClose }: { kind: ContractKindRow; terms: CommitmentTermRow[]; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const refresh = useRefreshGrid(kind.id);
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const m = useMutation({
    mutationFn: (dryRun: boolean) => contractKindsApi.importCsv(kind.id, file!, effectiveFrom, dryRun),
    onSuccess: (r) => {
      if (r.dryRun) return setPreview(r);
      toast.show(`Import terminé : ${importSummary(r)}.`, 'success');
      refresh();
      onClose();
    },
  });
  const errors = m.error instanceof ApiRequestError
    ? ((m.error.body as { errors?: Array<{ line: number; message: string }> } | null)?.errors ?? [])
    : [];
  const cols = terms.map((t) => `E${String(t.months).padStart(2, '0')}`);
  const reset = () => { setPreview(null); m.reset(); };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Importer la grille — ${kind.label}`}
      width={640}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
          {preview ? (
            <Button type="button" disabled={m.isPending} onClick={() => m.mutate(false)}>{m.isPending ? 'Patientez…' : 'Confirmer l’import'}</Button>
          ) : (
            <Button type="button" disabled={!file || m.isPending} onClick={() => m.mutate(true)}>{m.isPending ? 'Patientez…' : 'Analyser le fichier'}</Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink">
        <div className="rounded border border-line bg-slate-50 px-3 py-2 text-13 text-ink-muted">
          <p>Format : CSV séparé par « ; » (UTF-8), une ligne par code, virgule ou point décimal. Colonnes :</p>
          <p className="my-1 break-all font-mono text-xs">code;libelle;description;unite;periodicite;tva;{cols.join(';')};{cols.map((c) => `achat_${c}`).join(';')}</p>
          <ul className="list-disc pl-5">
            <li>code vide = nouveau code (numéro attribué automatiquement) ;</li>
            <li>unité et périodicité : libellé (« par utilisateur », « mensuelle ») ou code (PER_USER, MONTHLY) ;</li>
            <li>cellule de prix vide = durée non proposée ; colonne absente = durée inchangée ; colonnes achat_… facultatives.</li>
          </ul>
          <p className="mt-1">Le plus simple : partir de l’export CSV de la grille.</p>
        </div>
        <Field label="Fichier CSV" htmlFor={`${uid}-file`}>
          <input
            id={`${uid}-file`}
            type="file"
            accept=".csv,.txt,text/csv"
            className="text-sm"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
          />
        </Field>
        <Field label="Date d’effet des prix" htmlFor={`${uid}-eff`}>
          <Input id={`${uid}-eff`} type="date" value={effectiveFrom} onChange={(e) => { setEffectiveFrom(e.target.value); reset(); }} />
        </Field>
        {m.error && (
          <div role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">
            <p>{errorText(m.error)}</p>
            {errors.length > 0 && (
              <ul className="list-disc pl-5">{errors.map((x) => <li key={`${x.line}-${x.message}`}>Ligne {x.line} : {x.message}</li>)}</ul>
            )}
          </div>
        )}
        {preview && !m.error && (
          <div role="status" className="rounded border border-line px-3 py-2 text-13">
            <p className="font-medium">Aperçu (rien n’est encore enregistré) — prix datés du {fmtDay(preview.effectiveFrom)} :</p>
            <p>{importSummary(preview)}.</p>
            {preview.updated.length > 0 && <p className="text-xs text-ink-faint">Mis à jour : {preview.updated.join(', ')}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
