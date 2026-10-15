import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button, buttonClass } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { Tabs, type TabDef } from '../../ui/tabs.js';
import { useToast } from '../../ui/toast.js';
import { contractKindsApi } from './api.js';
import { KIND_PREFIX_RE } from './labels.js';
import { TermsPanel } from './terms-panel.js';
import type { ContractKindRow } from './types.js';

/**
 * Types de contrats (`/contract-kinds`, docs/contrats/13-types-contrats.md) :
 * référentiel des types (préfixe des codes tarifs) et des durées d'engagement.
 * Lecture pour tout interne ; écriture `pricing.grid.manage` (MSP_ADMIN).
 */
export function ContractKindsPage() {
  const me = useMe();
  const [tab, setTab] = useState('types');
  if (me.isLoading) return <Spinner />;
  const canManage = allows(me.data, 'pricing.grid.manage');
  const tabs: TabDef[] = [
    { id: 'types', label: 'Types de contrats' },
    { id: 'durees', label: 'Durées d’engagement' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Types de contrats' }]} />
      <h1>Types de contrats</h1>
      <p className="text-13 text-ink-muted">
        Chaque type porte une grille tarifaire : un code de base par prestation, décliné en une version par durée d’engagement.
      </p>
      <Tabs
        label="Types de contrats et durées"
        tabs={tabs}
        active={tab}
        onChange={setTab}
        panels={{
          types: <KindsPanel canManage={canManage} />,
          durees: <TermsPanel canManage={canManage} />,
        }}
      />
    </div>
  );
}

type Pending = { kind: ContractKindRow; action: 'archive' | 'unarchive' | 'delete' };

function KindsPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const q = useQuery({ queryKey: ['contract-kinds', archived], queryFn: () => contractKindsApi.list(archived) });
  const act = useMutation({
    mutationFn: (p: Pending): Promise<unknown> =>
      p.action === 'delete' ? contractKindsApi.remove(p.kind.id) : contractKindsApi.setArchived(p.kind.id, p.action === 'archive'),
    onSuccess: (_r, p) => {
      const verb = p.action === 'delete' ? 'supprimé' : p.action === 'archive' ? 'archivé' : 'désarchivé';
      toast.show(`Type « ${p.kind.label} » ${verb}.`, 'success');
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['contract-kinds'] });
    },
  });
  const open = (p: Pending) => { act.reset(); setPending(p); };
  const items = q.data?.items ?? [];
  return (
    <RegionCard title="Types de contrats" actions={canManage ? <Button type="button" size="sm" onClick={() => setCreating(true)}>Nouveau type</Button> : undefined}>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Afficher les archivés
      </label>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucun type de contrat.</p>}
      {items.length > 0 && (
        <Table caption="Types de contrats" head={<tr><th>Ordre</th><th>Libellé</th><th>Préfixe</th><th>Codes</th><th>Statut</th><th>Actions</th></tr>}>
          {items.map((k) => (
            <tr key={k.id}>
              <td className="tabular-nums">{k.sortOrder}</td>
              <td className="font-medium">
                {k.label}
                {k.description && <span className="block text-xs font-normal text-ink-faint">{k.description}</span>}
              </td>
              <td>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="font-mono">{k.prefix}</span>
                  {k.isSystem && <Badge tone="info">prédéfini</Badge>}
                  {k.prefixLocked && <Badge tone="muted"><span title="Des codes existent : le préfixe ne peut plus changer.">préfixe figé</span></Badge>}
                </span>
              </td>
              <td className="tabular-nums">{k.itemCount ?? 0}</td>
              <td>{k.archivedAt ? <Badge tone="muted">Archivé</Badge> : <Badge tone="success">Actif</Badge>}</td>
              <td>
                <span className="inline-flex flex-wrap gap-1.5">
                  <Link to={`/contract-kinds/${k.id}`} className={buttonClass('ghost', 'sm')} aria-label={`Ouvrir ${k.label}`}>Ouvrir</Link>
                  {canManage && (k.archivedAt ? (
                    <Button type="button" size="sm" variant="ghost" aria-label={`Désarchiver ${k.label}`} onClick={() => open({ kind: k, action: 'unarchive' })}>Désarchiver</Button>
                  ) : (
                    <Button type="button" size="sm" variant="danger-ghost" aria-label={`Archiver ${k.label}`} onClick={() => open({ kind: k, action: 'archive' })}>Archiver</Button>
                  ))}
                  {canManage && !k.isSystem && (k.itemCount ?? 0) === 0 && (
                    <Button type="button" size="sm" variant="danger-ghost" aria-label={`Supprimer ${k.label}`} onClick={() => open({ kind: k, action: 'delete' })}>Supprimer</Button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${pending.action === 'delete' ? 'Supprimer' : pending.action === 'archive' ? 'Archiver' : 'Désarchiver'} le type ${pending.kind.label}` : ''}
        confirmLabel={pending?.action === 'delete' ? 'Supprimer' : pending?.action === 'archive' ? 'Archiver' : 'Désarchiver'}
        variant={pending?.action === 'unarchive' ? 'primary' : 'danger'}
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => setPending(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        {pending?.action === 'archive' && <p>Le type et ses codes ne seront plus proposés dans les documents ; les documents existants restent inchangés.</p>}
        {pending?.action === 'unarchive' && <p>Le type sera de nouveau proposé, avec les codes de sa grille non archivés.</p>}
        {pending?.action === 'delete' && <p>Le type n’a aucun code tarif : il sera supprimé définitivement.</p>}
      </ConfirmDialog>
      {creating && <CreateKindDialog onClose={() => setCreating(false)} />}
    </RegionCard>
  );
}

function CreateKindDialog({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [prefix, setPrefix] = useState('');
  const [description, setDescription] = useState('');
  const [sortOrder, setSortOrder] = useState('');
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: contractKindsApi.create,
    onSuccess: (k) => {
      toast.show(`Type « ${k.label} » créé.`, 'success');
      void qc.invalidateQueries({ queryKey: ['contract-kinds'] });
      onClose();
    },
  });
  function submit() {
    const p = prefix.trim().toUpperCase();
    if (!KIND_PREFIX_RE.test(p)) return setFormError('Préfixe : 2 à 6 caractères, majuscules et chiffres (ex. M365).');
    const order = sortOrder.trim();
    if (order && !/^-?\d+$/.test(order)) return setFormError('Ordre : nombre entier attendu.');
    setFormError(undefined);
    m.mutate({
      label: label.trim(),
      prefix: p,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(order ? { sortOrder: Number(order) } : {}),
    });
  }
  return (
    <ConfirmDialog
      open
      title="Nouveau type de contrat"
      confirmLabel="Créer le type"
      disabled={!label.trim() || !prefix.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <Field label="Libellé" htmlFor={`${uid}-label`}>
        <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Préfixe" htmlFor={`${uid}-prefix`} hint="2 à 6 caractères, majuscules et chiffres : il débute chaque code tarif (M365-0001-E12). Figé dès le premier code créé.">
        <Input id={`${uid}-prefix`} value={prefix} maxLength={6} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`}>
        <Input id={`${uid}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Ordre d’affichage" htmlFor={`${uid}-order`}>
        <Input id={`${uid}-order`} inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
