import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { allows } from '../../lib/permissions.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Spinner } from '../../ui/spinner.js';
import { StatusBadge } from '../../ui/status-badge.js';
import { useToast } from '../../ui/toast.js';
import { StructureEditor } from './structure-editor.js';
import { useSaveStructure, useStructure } from './structure-api.js';

interface Detail { contract: { id: string; reference: string; title: string; status: string } }

/** Page d'édition du contenu structuré : /contracts/:id/structure. */
export function StructureEditorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const me = useMe();
  const detail = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const allowed = useQuery({
    queryKey: ['allowed-actions', id],
    queryFn: () => apiGet<{ allowedActions: string[] }>(`/v1/contracts/${id}/allowed-actions`),
  });
  const structure = useStructure(id);
  const save = useSaveStructure(id);

  if (detail.isLoading || structure.isLoading || allowed.isLoading) return <Spinner />;
  if (detail.error || !detail.data || structure.error || !structure.data) {
    return <p role="alert" className="text-danger">Contenu du contrat introuvable.</p>;
  }
  const c = detail.data.contract;
  const editable = (allowed.data?.allowedActions ?? []).includes('EDIT_CONTENT') && allows(me.data, 'contracts.write');

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[
        { label: 'Contrats', to: '/contracts' },
        { label: c.reference, to: `/contracts/${c.id}?onglet=contenu` },
        { label: 'Contenu structuré' },
      ]} />
      <div className="flex flex-wrap items-center gap-3">
        <h1>Contenu — {c.reference}</h1>
        <StatusBadge status={c.status} />
        {structure.data.versionNumber != null && <span className="text-sm text-ink-muted">Version {structure.data.versionNumber}</span>}
      </div>
      {!editable ? (
        <p role="status" className="rounded border border-line bg-page px-3 py-2 text-sm text-ink-muted">
          Le contenu de ce contrat n’est pas modifiable (statut ou droits insuffisants).
        </p>
      ) : (
        <StructureEditor
          key={structure.data.versionId ?? 'none'}
          structure={structure.data}
          status={c.status}
          saving={save.isPending}
          error={save.error}
          onSave={(payload) => save.mutate(payload, {
            onSuccess: (r) => {
              toast.show(`Version ${r.versionNumber} enregistrée.`, 'success');
              nav(`/contracts/${id}?onglet=contenu`);
            },
          })}
        />
      )}
    </div>
  );
}
