import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { Tabs, type TabDef } from '../../ui/tabs.js';
import { useToast } from '../../ui/toast.js';
import { contractKindsApi, type KindInput } from './api.js';
import { GridPanel, gridKey } from './grid-panel.js';
import { euros, fmtDay, KIND_PREFIX_RE, todayIso } from './labels.js';
import type { ContractKindRow } from './types.js';

/**
 * Fiche d'un type de contrat (`/contract-kinds/:id`) : grille tarifaire,
 * historique des prix, contenu contractuel rattaché et paramètres.
 */
export function ContractKindDetailPage() {
  const { id = '' } = useParams();
  const me = useMe();
  const [tab, setTab] = useState('grille');
  const q = useQuery({ queryKey: ['contract-kind', id], queryFn: () => contractKindsApi.get(id) });
  if (me.isLoading || q.isLoading) return <Spinner />;
  const canManage = allows(me.data, 'pricing.grid.manage');
  const k = q.data;
  const crumbs = [{ label: 'Types de contrats', to: '/contract-kinds' }, { label: k?.label ?? 'Type de contrat' }];
  if (!k) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb items={crumbs} />
        <ErrorNote>{errorText(q.error, 'Type de contrat introuvable.') ?? 'Type de contrat introuvable.'}</ErrorNote>
      </div>
    );
  }
  const tabs: TabDef[] = [
    { id: 'grille', label: 'Grille tarifaire' },
    { id: 'historique', label: 'Historique' },
    { id: 'contenu', label: 'Contenu contractuel' },
    { id: 'parametres', label: 'Paramètres' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={crumbs} />
      <div className="flex flex-wrap items-center gap-2">
        <h1>{k.label}</h1>
        <span className="font-mono text-sm text-ink-muted">{k.prefix}</span>
        {k.isSystem && <Badge tone="info">prédéfini</Badge>}
        {k.prefixLocked && <Badge tone="muted">préfixe figé</Badge>}
        {k.archivedAt ? <Badge tone="muted">Archivé</Badge> : <Badge tone="success">Actif</Badge>}
      </div>
      {k.description && <p className="text-13 text-ink-muted">{k.description}</p>}
      <Tabs
        label={`Type de contrat ${k.label}`}
        tabs={tabs}
        active={tab}
        onChange={setTab}
        panels={{
          grille: <GridPanel kind={k} canManage={canManage} />,
          historique: <HistoryPanel kind={k} />,
          contenu: <ContentPanel kind={k} canManage={canManage} />,
          parametres: <SettingsPanel kind={k} canManage={canManage} />,
        }}
      />
    </div>
  );
}

function HistoryPanel({ kind }: { kind: ContractKindRow }) {
  const uid = useId();
  const [code, setCode] = useState('');
  const today = todayIso();
  const grid = useQuery({ queryKey: [...gridKey(kind.id), today, true], queryFn: () => contractKindsApi.grid(kind.id, today, true) });
  const h = useQuery({ queryKey: ['price-grid-history', code], queryFn: () => contractKindsApi.history(code), enabled: Boolean(code) });
  const termLabel = (months: number) => grid.data?.terms.find((t) => t.months === months)?.label ?? `${months} mois`;
  return (
    <RegionCard title="Historique des prix">
      <p className="text-13 text-ink-muted">Tous les prix saisis pour un code, par durée, du plus récent au plus ancien. Un prix n’est jamais écrasé.</p>
      {grid.isLoading && <Spinner />}
      <ErrorNote>{errorText(grid.error)}</ErrorNote>
      {grid.data && (
        <Field label="Code" htmlFor={`${uid}-code`}>
          <Select id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">— Choisir un code —</option>
            {grid.data.items.map((i) => <option key={i.id} value={i.code}>{`${i.code} — ${i.label}${i.archivedAt ? ' (archivé)' : ''}`}</option>)}
          </Select>
        </Field>
      )}
      {h.isLoading && code && <Spinner />}
      <ErrorNote>{errorText(h.error)}</ErrorNote>
      {h.data && h.data.variants.length === 0 && <p className="text-13 text-ink-faint">Aucun prix saisi pour ce code.</p>}
      {h.data?.variants.map((v) => (
        <div key={v.code} className="flex flex-col gap-1">
          <h3 className="text-sm font-title text-ink">
            {termLabel(v.months)} <span className="font-mono text-ink-muted">{v.code}</span>
            {v.archivedAt && <span className="ml-1.5"><Badge tone="muted">Non proposée</Badge></span>}
          </h3>
          <Table caption={`Historique ${v.code}`} head={<tr><th>Date d’effet</th><th>Prix de vente</th><th>Prix d’achat</th><th>Saisi le</th></tr>}>
            {[...v.prices].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt)).map((p) => (
              <tr key={p.id}>
                <td>{fmtDay(p.effectiveFrom)}</td>
                <td className="tabular-nums">{euros(p.unitPrice)}</td>
                <td className="tabular-nums">{euros(p.purchasePrice)}</td>
                <td>{fmtDay(p.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </div>
      ))}
    </RegionCard>
  );
}

function useSaveKind(kind: ContractKindRow, success: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (b: KindInput) => contractKindsApi.update(kind.id, b),
    onSuccess: (k) => {
      toast.show(success, 'success');
      qc.setQueryData(['contract-kind', kind.id], k);
      void qc.invalidateQueries({ queryKey: ['contract-kind', kind.id] });
      void qc.invalidateQueries({ queryKey: ['contract-kinds'] });
      void qc.invalidateQueries({ queryKey: gridKey(kind.id) });
    },
  });
}

function ContentPanel({ kind, canManage }: { kind: ContractKindRow; canManage: boolean }) {
  const uid = useId();
  const templates = useQuery({ queryKey: ['templates'], queryFn: contractKindsApi.templates, retry: false });
  const [selected, setSelected] = useState(kind.contractTemplateId ?? '');
  useEffect(() => setSelected(kind.contractTemplateId ?? ''), [kind.contractTemplateId]);
  const save = useSaveKind(kind, 'Contenu contractuel mis à jour.');
  const linked = kind.contractTemplateId ? templates.data?.items.find((t) => t.id === kind.contractTemplateId) : undefined;
  return (
    <RegionCard title="Contenu contractuel">
      <p className="text-13 text-ink-muted">
        Le texte contractuel du type (conditions générales et particulières, périmètre, niveaux de service, annexes, clauses) sera rattaché
        par un modèle de contrat, versionné avec une date d’effet.
      </p>
      {kind.contractTemplateId ? (
        <p className="text-sm">
          Modèle rattaché :{' '}
          <Link to={`/templates/${kind.contractTemplateId}`} className="text-primary hover:underline">{linked?.name ?? 'Modèle de contrat'}</Link>
        </p>
      ) : (
        <p className="text-sm text-ink-faint">Aucun contenu contractuel rattaché pour l’instant.</p>
      )}
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); save.mutate({ contractTemplateId: selected || null }); }}
        >
          <Field label="Modèle de contrat" htmlFor={`${uid}-tpl`}>
            <Select id={`${uid}-tpl`} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Aucun</option>
              {(templates.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" disabled={save.isPending || selected === (kind.contractTemplateId ?? '')}>
            {selected ? 'Rattacher le modèle' : 'Détacher le modèle'}
          </Button>
        </form>
      )}
      {canManage && <ErrorNote>{errorText(templates.error) ?? errorText(save.error)}</ErrorNote>}
    </RegionCard>
  );
}

function SettingsPanel({ kind, canManage }: { kind: ContractKindRow; canManage: boolean }) {
  const uid = useId();
  const init = () => ({ label: kind.label, prefix: kind.prefix, description: kind.description ?? '', sortOrder: String(kind.sortOrder) });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [kind]);
  const [formError, setFormError] = useState<string>();
  const save = useSaveKind(kind, 'Paramètres du type enregistrés.');
  function submit(e: FormEvent) {
    e.preventDefault();
    const b: KindInput = {};
    if (f.label.trim() !== kind.label) b.label = f.label.trim();
    const p = f.prefix.trim().toUpperCase();
    if (!kind.prefixLocked && p !== kind.prefix) {
      if (!KIND_PREFIX_RE.test(p)) return setFormError('Préfixe : 2 à 6 caractères, majuscules et chiffres (ex. M365).');
      b.prefix = p;
    }
    if (f.description.trim() !== (kind.description ?? '')) b.description = f.description.trim() || null;
    if (!/^-?\d+$/.test(f.sortOrder.trim())) return setFormError('Ordre : nombre entier attendu.');
    if (Number(f.sortOrder.trim()) !== kind.sortOrder) b.sortOrder = Number(f.sortOrder.trim());
    if (!f.label.trim()) return setFormError('Le libellé est obligatoire.');
    setFormError(undefined);
    if (Object.keys(b).length) save.mutate(b);
  }
  return (
    <form aria-label="Paramètres du type" noValidate onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-15 font-title text-ink">Paramètres</h2>
      <fieldset disabled={!canManage} className="grid gap-3 sm:grid-cols-2">
        <Field label="Libellé" htmlFor={`${uid}-label`}>
          <Input id={`${uid}-label`} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>
        <Field
          label="Préfixe"
          htmlFor={`${uid}-prefix`}
          hint={kind.prefixLocked
            ? 'Figé : des codes tarifs ont été créés avec ce préfixe, il ne peut plus changer.'
            : '2 à 6 caractères, majuscules et chiffres. Figé dès le premier code créé.'}
        >
          <Input id={`${uid}-prefix`} value={f.prefix} maxLength={6} disabled={kind.prefixLocked} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Description" htmlFor={`${uid}-desc`}>
          <Input id={`${uid}-desc`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Ordre d’affichage" htmlFor={`${uid}-order`}>
          <Input id={`${uid}-order`} inputMode="numeric" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
        </Field>
      </fieldset>
      {canManage && <div><Button type="submit" disabled={save.isPending}>Enregistrer</Button></div>}
      <ErrorNote>{formError ?? errorText(save.error)}</ErrorNote>
    </form>
  );
}
