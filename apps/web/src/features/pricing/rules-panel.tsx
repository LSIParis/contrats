import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
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
import { RULE_TYPE_LABELS } from './labels.js';
import type { PricingRuleRow, RuleType } from './types.js';

/**
 * Catalogue de règles du tenant (04 §4.2, §17.6) : grilles par article,
 * tables de paliers, remises sur volume et d'engagement. Pas de suppression :
 * une règle citée par un barème reste résoluble, on l'archive. Le catalogue
 * est l'état COURANT (V2-H27) : pour figer des prix, créer une grille par
 * millésime (« grille-2027 »).
 */
const n0 = (v: unknown) => formatDecimal(String(v ?? ''), { minFraction: 0 });

export function ruleSummary(r: Pick<PricingRuleRow, 'type' | 'definition'>): string {
  const d = r.definition as Record<string, unknown>;
  switch (r.type) {
    case 'GRID':
      return `${(d.entries as unknown[] | undefined)?.length ?? 0} article(s)`;
    case 'TIERS': {
      const t = d.table as { mode?: string; tiers?: unknown[] } | undefined;
      return `${t?.tiers?.length ?? 0} palier(s) ${t?.mode === 'VOLUME' ? 'au volume' : 'par tranches'}`;
    }
    case 'VOLUME_DISCOUNT':
      return ((d.thresholds as Array<{ minQuantity: string; percent: string }> | undefined) ?? [])
        .map((t) => `≥ ${n0(t.minQuantity)} : −${n0(t.percent)} %`).join(' ; ');
    case 'COMMITMENT_DISCOUNT':
      return ((d.thresholds as Array<{ minMonths: number; percent: string }> | undefined) ?? [])
        .map((t) => `≥ ${t.minMonths} mois : −${n0(t.percent)} %`).join(' ; ');
    default:
      return '';
  }
}

export function RulesPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<PricingRuleRow | null>(null);
  const q = useQuery({
    queryKey: ['pricing-rules', archived],
    queryFn: () => apiRequest<{ items: PricingRuleRow[] }>('GET', archived ? '/v1/pricing-rules?archived=true' : '/v1/pricing-rules'),
  });
  const archive = useMutation({
    mutationFn: (code: string) => apiRequest<PricingRuleRow>('POST', `/v1/pricing-rules/${encodeURIComponent(code)}/archive`),
    onSuccess: (r) => {
      toast.show(`Règle ${r.code} archivée.`, 'success');
      setArchiving(null);
      void qc.invalidateQueries({ queryKey: ['pricing-rules'] });
    },
  });
  const items = q.data?.items ?? [];
  return (
    <RegionCard title="Règles de prix" actions={canManage ? <Button type="button" size="sm" onClick={() => setCreating(true)}>Nouvelle règle</Button> : undefined}>
      <p className="text-13 text-ink-muted">
        Modifier une règle change le prix des lignes qui la citent, à toute date : pour figer des prix, créer une règle par millésime.
      </p>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Afficher les règles archivées
      </label>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucune règle.</p>}
      {items.length > 0 && (
        <Table caption="Règles de prix" head={<tr><th>Code</th><th>Type</th><th>Libellé</th><th>Définition</th><th>État</th>{canManage && <th>Actions</th>}</tr>}>
          {items.map((r) => (
            <tr key={r.id}>
              <td className="font-medium">{r.code}</td>
              <td>{RULE_TYPE_LABELS[r.type] ?? r.type}</td>
              <td>{r.label}</td>
              <td>{ruleSummary(r)}</td>
              <td>{r.archivedAt ? <Badge tone="muted">Archivée</Badge> : <Badge tone="success">Active</Badge>}</td>
              {canManage && (
                <td>
                  {!r.archivedAt && (
                    <Button type="button" size="sm" variant="danger-ghost" aria-label={`Archiver ${r.code}`} onClick={() => { archive.reset(); setArchiving(r); }}>
                      Archiver
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
      <ConfirmDialog
        open={archiving !== null}
        title={`Archiver la règle ${archiving?.code ?? ''}`}
        confirmLabel="Archiver"
        variant="danger"
        onConfirm={() => archiving && archive.mutate(archiving.code)}
        onClose={() => setArchiving(null)}
        pending={archive.isPending}
        error={errorText(archive.error)}
      >
        <p>La règle ne sera plus proposée pour de nouvelles lignes ; les barèmes qui la citent continuent de la résoudre.</p>
      </ConfirmDialog>
      {creating && <CreateRuleDialog onClose={() => setCreating(false)} />}
    </RegionCard>
  );
}

type Row = { a: string; b: string };
const COLUMNS: Record<RuleType, [string, string]> = {
  GRID: ['Article', 'Prix unitaire HT'],
  TIERS: ['Borne haute (vide = illimité)', 'Prix unitaire'],
  VOLUME_DISCOUNT: ['Quantité minimale', 'Remise (%)'],
  COMMITMENT_DISCOUNT: ['Durée minimale (mois)', 'Remise (%)'],
};

/** Lignes saisies → `definition` au format de `RuleDefinitionSchemas` (API). */
export function buildDefinition(type: RuleType, rows: Row[], tierMode: 'GRADUATED' | 'VOLUME'): { definition: Record<string, unknown> } | { error: string } {
  const used = rows.filter((r) => r.a.trim() || r.b.trim());
  if (used.length === 0) return { error: 'Au moins une ligne est requise.' };
  const dec = (v: string, max = 6) => decimalFromInput(v, { maxFraction: max });
  for (const [i, r] of used.entries()) {
    const second = dec(r.b, type === 'GRID' || type === 'TIERS' ? 6 : 4);
    if (!second) return { error: `Ligne ${i + 1} : ${COLUMNS[type][1].toLowerCase()} invalide.` };
    if (type === 'GRID' && !r.a.trim()) return { error: `Ligne ${i + 1} : article obligatoire.` };
    if (type === 'TIERS' && r.a.trim() && !dec(r.a)) return { error: `Ligne ${i + 1} : borne invalide.` };
    if (type === 'VOLUME_DISCOUNT' && !dec(r.a)) return { error: `Ligne ${i + 1} : quantité invalide.` };
    if (type === 'COMMITMENT_DISCOUNT' && !/^\d{1,3}$/.test(r.a.trim())) return { error: `Ligne ${i + 1} : durée en mois entiers attendue.` };
  }
  switch (type) {
    case 'GRID':
      return { definition: { entries: used.map((r) => ({ articleCode: r.a.trim(), unitPrice: dec(r.b)! })) } };
    case 'TIERS':
      return { definition: { table: { mode: tierMode, tiers: used.map((r) => ({ upTo: r.a.trim() ? dec(r.a)! : null, unitPrice: dec(r.b)! })) } } };
    case 'VOLUME_DISCOUNT':
      return { definition: { thresholds: used.map((r) => ({ minQuantity: dec(r.a)!, percent: dec(r.b, 4)! })) } };
    case 'COMMITMENT_DISCOUNT':
      return { definition: { thresholds: used.map((r) => ({ minMonths: Number(r.a.trim()), percent: dec(r.b, 4)! })) } };
  }
}

function CreateRuleDialog({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [type, setType] = useState<RuleType>('GRID');
  const [label, setLabel] = useState('');
  const [tierMode, setTierMode] = useState<'GRADUATED' | 'VOLUME'>('GRADUATED');
  const [rows, setRows] = useState<Row[]>([{ a: '', b: '' }]);
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<PricingRuleRow>('POST', '/v1/pricing-rules', body),
    onSuccess: (r) => {
      toast.show(`Règle ${r.code} créée.`, 'success');
      void qc.invalidateQueries({ queryKey: ['pricing-rules'] });
      onClose();
    },
  });
  function submit() {
    const d = buildDefinition(type, rows, tierMode);
    if ('error' in d) return setFormError(d.error);
    setFormError(undefined);
    m.mutate({ code: code.trim(), type, label: label.trim(), definition: d.definition });
  }
  const [colA, colB] = COLUMNS[type];
  const setRow = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <ConfirmDialog
      open
      title="Nouvelle règle"
      confirmLabel="Créer la règle"
      disabled={!code.trim() || !label.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code" htmlFor={`${uid}-code`} hint="Ex. grille-2027 (lettres, chiffres, « _ . - »).">
          <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Type" htmlFor={`${uid}-type`}>
          <Select id={`${uid}-type`} value={type} onChange={(e) => { setType(e.target.value as RuleType); setRows([{ a: '', b: '' }]); }}>
            {(Object.keys(RULE_TYPE_LABELS) as RuleType[]).map((t) => <option key={t} value={t}>{RULE_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Libellé" htmlFor={`${uid}-label`}>
        <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      {type === 'TIERS' && (
        <Field label="Mode des paliers" htmlFor={`${uid}-tmode`}>
          <Select id={`${uid}-tmode`} value={tierMode} onChange={(e) => setTierMode(e.target.value as 'GRADUATED' | 'VOLUME')}>
            <option value="GRADUATED">Par tranches</option>
            <option value="VOLUME">Au volume (palier atteint)</option>
          </Select>
        </Field>
      )}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label={`${colA} ${i + 1}`} htmlFor={`${uid}-a-${i}`}>
            <Input id={`${uid}-a-${i}`} value={r.a} onChange={(e) => setRow(i, { a: e.target.value })} />
          </Field>
          <Field label={`${colB} ${i + 1}`} htmlFor={`${uid}-b-${i}`}>
            <Input id={`${uid}-b-${i}`} inputMode="decimal" value={r.b} onChange={(e) => setRow(i, { b: e.target.value })} />
          </Field>
          <Button type="button" size="sm" variant="danger-ghost" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            Retirer la ligne {i + 1}
          </Button>
        </div>
      ))}
      <div><Button type="button" size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, { a: '', b: '' }])}>Ajouter une ligne</Button></div>
    </ConfirmDialog>
  );
}
