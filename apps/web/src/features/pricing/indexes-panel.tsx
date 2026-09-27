import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiRequest, errorText } from '../../lib/api.js';
import { decimalFromInput, formatDecimal } from '../../lib/money.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { fmtDay } from './labels.js';
import type { IndexValueRow, PriceIndexRow } from './types.js';

/**
 * Indices de prix (04 §6.2, §17.5) : séries du tenant, valeurs publiées
 * (append-only : une correction crée une nouvelle valeur qui remplace la
 * courante, avec motif), import par connecteur CSV `période;valeur[;date]`
 * en tout ou rien. Aucune valeur codée en dur.
 */
const idxValue = (v: string) => formatDecimal(v, { minFraction: 0 });

export function IndexesPanel({ canManage }: { canManage: boolean }) {
  const q = useQuery({ queryKey: ['price-indexes'], queryFn: () => apiRequest<{ items: PriceIndexRow[] }>('GET', '/v1/price-indexes') });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const items = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <RegionCard title="Indices" actions={canManage ? <Button type="button" size="sm" onClick={() => setCreating(true)}>Nouvel indice</Button> : undefined}>
        {q.isLoading && <Spinner />}
        <ErrorNote>{errorText(q.error)}</ErrorNote>
        {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucun indice : créer une série (ex. SYNTEC) puis saisir ou importer ses valeurs.</p>}
        {items.length > 0 && (
          <Table caption="Indices de prix" head={<tr><th>Code</th><th>Libellé</th><th>Dernière valeur</th><th>Valeurs</th><th>Connecteur</th><th>Actions</th></tr>}>
            {items.map((i) => (
              <tr key={i.id}>
                <td className="font-medium">{i.code}</td>
                <td>{i.label}{i.description && <span className="block text-xs text-ink-faint">{i.description}</span>}</td>
                <td>{i.latest ? `${i.latest.period} : ${idxValue(i.latest.value)} (publiée le ${fmtDay(i.latest.publishedAt)})` : '—'}</td>
                <td>{i.valuesCount}</td>
                <td>{i.connector ? `${i.connector.type}${i.connector.delimiter ? ` « ${i.connector.delimiter === '\t' ? 'tabulation' : i.connector.delimiter} »` : ''}` : 'CSV « ; »'}</td>
                <td>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Valeurs de ${i.code}`} onClick={() => setSelected(selected === i.code ? null : i.code)}>
                    {selected === i.code ? 'Masquer' : 'Valeurs'}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </RegionCard>
      {selected && <IndexValues key={selected} code={selected} canManage={canManage} />}
      {creating && <CreateIndexDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateIndexDialog({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [delimiter, setDelimiter] = useState(';');
  const [decimalComma, setDecimalComma] = useState(false);
  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<PriceIndexRow>('POST', '/v1/price-indexes', body),
    onSuccess: (r) => {
      toast.show(`Indice ${r.code} créé.`, 'success');
      void qc.invalidateQueries({ queryKey: ['price-indexes'] });
      onClose();
    },
  });
  function submit() {
    const custom = delimiter !== ';' || decimalComma;
    m.mutate({
      code: code.trim().toUpperCase(),
      label: label.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(custom ? { connector: { type: 'CSV', delimiter, ...(decimalComma && delimiter !== ',' ? { decimalComma: true } : {}) } } : {}),
    });
  }
  return (
    <ConfirmDialog
      open
      title="Nouvel indice"
      confirmLabel="Créer l’indice"
      disabled={!code.trim() || !label.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={errorText(m.error)}
    >
      <Field label="Code" htmlFor={`${uid}-code`} hint="MAJUSCULES, chiffres et « _ », ex. SYNTEC.">
        <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Libellé" htmlFor={`${uid}-label`}>
        <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`}>
        <Input id={`${uid}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Séparateur du fichier CSV" htmlFor={`${uid}-delim`}>
        <Select id={`${uid}-delim`} value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
          <option value=";">Point-virgule (défaut)</option>
          <option value=",">Virgule</option>
          <option value={'\t'}>Tabulation</option>
        </Select>
      </Field>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={decimalComma} disabled={delimiter === ','} onChange={(e) => setDecimalComma(e.target.checked)} />
        Accepter la virgule décimale (« 321,5 »)
      </label>
    </ConfirmDialog>
  );
}

function IndexValues({ code, canManage }: { code: string; canManage: boolean }) {
  const uid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const path = `/v1/price-indexes/${encodeURIComponent(code)}/values`;
  const q = useQuery({ queryKey: ['price-index-values', code], queryFn: () => apiRequest<{ items: IndexValueRow[] }>('GET', path) });
  const [period, setPeriod] = useState('');
  const [value, setValue] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [correcting, setCorrecting] = useState<IndexValueRow | null>(null);
  const [correctionReason, setCorrectionReason] = useState('');
  const [formError, setFormError] = useState<string>();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['price-index-values', code] });
    void qc.invalidateQueries({ queryKey: ['price-indexes'] });
  };

  const add = useMutation({
    mutationFn: (body: unknown) => apiRequest<IndexValueRow>('POST', path, body),
    onSuccess: () => {
      toast.show(correcting ? `Valeur ${period} corrigée.` : `Valeur ${period} enregistrée.`, 'success');
      setPeriod('');
      setValue('');
      setPublishedAt('');
      setCorrecting(null);
      setCorrectionReason('');
      refresh();
    },
  });
  const imp = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return apiRequest<{ imported: number; unchanged: number; periods: string[] }>('POST', `${path}/import`, undefined, { form });
    },
    onSuccess: () => refresh(),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = decimalFromInput(value);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim())) return setFormError('Période attendue au format AAAA-MM.');
    if (!v) return setFormError('Valeur invalide (nombre positif, ≤ 6 décimales).');
    if (!publishedAt) return setFormError('Date de publication obligatoire.');
    if (correcting && !correctionReason.trim()) return setFormError('Une correction exige son motif.');
    setFormError(undefined);
    add.mutate({
      period: period.trim(), value: v, publishedAt,
      ...(correcting ? { supersedesId: correcting.id, correctionReason: correctionReason.trim() } : {}),
    });
  }

  const importErrors = imp.error instanceof ApiRequestError
    ? ((imp.error.body as { errors?: Array<{ line: number; message: string }> } | null)?.errors ?? [])
    : [];

  return (
    <RegionCard title={`Valeurs — ${code}`}>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && q.data.items.length === 0 && <p className="text-13 text-ink-faint">Aucune valeur publiée.</p>}
      {q.data && q.data.items.length > 0 && (
        <Table caption={`Valeurs de ${code}`} head={<tr><th>Période</th><th>Valeur</th><th>Publiée le</th><th>Source</th><th>Révision</th><th>État</th>{canManage && <th>Actions</th>}</tr>}>
          {[...q.data.items].sort((a, b) => b.period.localeCompare(a.period) || b.revision - a.revision).map((v) => (
            <tr key={v.id}>
              <td>{v.period}</td>
              <td className="tabular-nums">{idxValue(v.value)}</td>
              <td>{fmtDay(v.publishedAt)}</td>
              <td>{v.source === 'IMPORT' ? 'Import' : 'Saisie'}</td>
              <td>{v.revision}{v.correctionReason && <span className="block text-xs text-ink-faint">{v.correctionReason}</span>}</td>
              <td>{v.current ? <Badge tone="success">Courante</Badge> : <Badge tone="muted">Remplacée</Badge>}</td>
              {canManage && (
                <td>
                  {v.current && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Corriger ${v.period}`}
                      onClick={() => { setCorrecting(v); setPeriod(v.period); add.reset(); }}
                    >
                      Corriger
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}

      {canManage && (
        <>
          <form noValidate onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line p-4">
            <h3 className="text-sm font-title text-ink">{correcting ? `Correction de ${correcting.period} (valeur courante ${idxValue(correcting.value)})` : 'Saisir une valeur'}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Période (AAAA-MM)" htmlFor={`${uid}-period`}>
                <Input id={`${uid}-period`} placeholder="2026-06" value={period} disabled={Boolean(correcting)} onChange={(e) => setPeriod(e.target.value)} />
              </Field>
              <Field label="Valeur" htmlFor={`${uid}-value`}>
                <Input id={`${uid}-value`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
              <Field label="Publiée le" htmlFor={`${uid}-pub`}>
                <Input id={`${uid}-pub`} type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
              </Field>
              {correcting && (
                <div className="sm:col-span-3">
                  <Field label="Motif de la correction" htmlFor={`${uid}-reason`}>
                    <Input id={`${uid}-reason`} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} />
                  </Field>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={add.isPending}>{correcting ? 'Enregistrer la correction' : 'Enregistrer la valeur'}</Button>
              {correcting && <Button type="button" variant="secondary" onClick={() => { setCorrecting(null); setCorrectionReason(''); }}>Abandonner la correction</Button>}
            </div>
            <ErrorNote>{formError ?? errorText(add.error)}</ErrorNote>
          </form>

          <form
            className="flex flex-col gap-3 rounded-lg border border-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = fileRef.current?.files?.[0];
              if (f) imp.mutate(f);
            }}
          >
            <h3 className="text-sm font-title text-ink">Importer un fichier</h3>
            <Field
              label="Fichier CSV"
              htmlFor={`${uid}-file`}
              hint="Colonnes période;valeur[;date de publication], en-tête et commentaires tolérés, 1 000 lignes max. Tout ou rien : une ligne invalide refuse le fichier."
            >
              <input id={`${uid}-file`} ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="text-sm" />
            </Field>
            <div><Button type="submit" variant="secondary" disabled={imp.isPending}>{imp.isPending ? 'Import…' : 'Importer le fichier'}</Button></div>
            {imp.error && (
              <div role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">
                <p>{errorText(imp.error)}</p>
                {importErrors.length > 0 && (
                  <ul className="list-disc pl-5">{importErrors.map((x) => <li key={`${x.line}-${x.message}`}>Ligne {x.line} : {x.message}</li>)}</ul>
                )}
              </div>
            )}
            {imp.data && !imp.error && (
              <p role="status" className="text-13 text-success">
                {`${imp.data.imported} valeur(s) importée(s)${imp.data.periods.length ? ` (${imp.data.periods.join(', ')})` : ''}, ${imp.data.unchanged} inchangée(s).`}
              </p>
            )}
          </form>
        </>
      )}
    </RegionCard>
  );
}
