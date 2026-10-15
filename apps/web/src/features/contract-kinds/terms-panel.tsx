import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '../../lib/api.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { contractKindsApi } from './api.js';
import { commitmentSuffix, MAX_COMMITMENT_MONTHS } from './labels.js';
import type { CommitmentTermRow } from './types.js';

/**
 * Durées d'engagement du tenant : une colonne de chaque grille. Le nombre de
 * mois est figé à la création (il figure dans les codes, « E12 ») ; seul le
 * libellé change, et une durée s'archive au lieu de se supprimer.
 */
export function TermsPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CommitmentTermRow | null>(null);
  const [toggling, setToggling] = useState<CommitmentTermRow | null>(null);
  const q = useQuery({ queryKey: ['commitment-terms', archived], queryFn: () => contractKindsApi.terms(archived) });
  const toggle = useMutation({
    mutationFn: (t: CommitmentTermRow) => contractKindsApi.updateTerm(t.months, { archived: !t.archivedAt }),
    onSuccess: (t) => {
      toast.show(`Durée « ${t.label} » ${t.archivedAt ? 'archivée' : 'désarchivée'}.`, 'success');
      setToggling(null);
      void qc.invalidateQueries({ queryKey: ['commitment-terms'] });
      void qc.invalidateQueries({ queryKey: ['contract-kind-grid'] });
    },
  });
  const items = q.data?.items ?? [];
  return (
    <RegionCard title="Durées d’engagement" actions={canManage ? <Button type="button" size="sm" onClick={() => setCreating(true)}>Nouvelle durée</Button> : undefined}>
      <p className="text-13 text-ink-muted">
        Chaque durée active est une colonne des grilles tarifaires. 0 mois = sans engagement. Le nombre de mois est figé dès la création :
        il figure dans les codes tarifs (E00, E12, E24…). Seul le libellé se modifie ; une durée inutilisée s’archive.
      </p>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Afficher les durées archivées
      </label>
      {q.isLoading && <Spinner />}
      <ErrorNote>{errorText(q.error)}</ErrorNote>
      {q.data && items.length === 0 && <p className="text-13 text-ink-faint">Aucune durée d’engagement.</p>}
      {items.length > 0 && (
        <Table caption="Durées d’engagement" head={<tr><th>Mois</th><th>Suffixe</th><th>Libellé</th><th>Statut</th>{canManage && <th>Actions</th>}</tr>}>
          {items.map((t) => (
            <tr key={t.id}>
              <td className="tabular-nums">{t.months}</td>
              <td className="font-mono">{commitmentSuffix(t.months)}</td>
              <td>{t.label}</td>
              <td>{t.archivedAt ? <Badge tone="muted">Archivée</Badge> : <Badge tone="success">Active</Badge>}</td>
              {canManage && (
                <td>
                  <span className="inline-flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" variant="ghost" aria-label={`Renommer ${t.label}`} onClick={() => setEditing(t)}>Renommer</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={t.archivedAt ? 'ghost' : 'danger-ghost'}
                      aria-label={`${t.archivedAt ? 'Désarchiver' : 'Archiver'} ${t.label}`}
                      onClick={() => { toggle.reset(); setToggling(t); }}
                    >
                      {t.archivedAt ? 'Désarchiver' : 'Archiver'}
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
        title={`${toggling?.archivedAt ? 'Désarchiver' : 'Archiver'} la durée ${toggling?.label ?? ''}`}
        confirmLabel={toggling?.archivedAt ? 'Désarchiver' : 'Archiver'}
        variant={toggling?.archivedAt ? 'primary' : 'danger'}
        onConfirm={() => toggling && toggle.mutate(toggling)}
        onClose={() => setToggling(null)}
        pending={toggle.isPending}
        error={errorText(toggle.error)}
      >
        <p>
          {toggling?.archivedAt
            ? 'La durée redevient une colonne des grilles ; les versions de code existantes sont reprises telles quelles.'
            : 'La durée disparaît des grilles et des sélecteurs ; les documents existants restent inchangés.'}
        </p>
      </ConfirmDialog>
      {creating && <TermDialog onClose={() => setCreating(false)} />}
      {editing && <TermDialog term={editing} onClose={() => setEditing(null)} />}
    </RegionCard>
  );
}

function TermDialog({ term, onClose }: { term?: CommitmentTermRow; onClose: () => void }) {
  const uid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [months, setMonths] = useState(term ? String(term.months) : '');
  const [label, setLabel] = useState(term?.label ?? '');
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (b: { months: number; label: string }) =>
      term ? contractKindsApi.updateTerm(term.months, { label: b.label }) : contractKindsApi.createTerm(b),
    onSuccess: (t) => {
      toast.show(term ? `Durée « ${t.label} » renommée.` : `Durée « ${t.label} » créée.`, 'success');
      void qc.invalidateQueries({ queryKey: ['commitment-terms'] });
      void qc.invalidateQueries({ queryKey: ['contract-kind-grid'] });
      onClose();
    },
  });
  function submit() {
    const n = Number(months.trim());
    if (!/^\d{1,2}$/.test(months.trim()) || n > MAX_COMMITMENT_MONTHS) return setFormError(`Durée : nombre entier de mois entre 0 et ${MAX_COMMITMENT_MONTHS}.`);
    setFormError(undefined);
    m.mutate({ months: n, label: label.trim() });
  }
  return (
    <ConfirmDialog
      open
      title={term ? `Renommer la durée de ${term.months} mois` : 'Nouvelle durée d’engagement'}
      confirmLabel={term ? 'Enregistrer' : 'Créer la durée'}
      disabled={!months.trim() || !label.trim()}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <Field label="Nombre de mois" htmlFor={`${uid}-months`} hint={term ? 'Figé : il figure dans les codes tarifs.' : '0 = sans engagement ; figé après création.'}>
        <Input id={`${uid}-months`} inputMode="numeric" value={months} disabled={Boolean(term)} onChange={(e) => setMonths(e.target.value)} />
      </Field>
      <Field label="Libellé" htmlFor={`${uid}-label`} hint="Ex. « 12 mois », « Sans engagement ».">
        <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
