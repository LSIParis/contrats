import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { ContentEditor } from './content-editor.js';

interface Detail { contract: { status: string; currentVersionId: string | null } }
interface Version { bodyHtml: string }

const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];

export function ContractEditPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const versionId = detail.data?.contract.currentVersionId ?? null;
  const version = useQuery({
    queryKey: ['version', id, versionId],
    queryFn: () => apiGet<Version>(`/v1/contracts/${id}/versions/${versionId}`),
    enabled: !!versionId,
  });

  const m = useMutation({
    mutationFn: (html: string) => apiPut<{ id: string }>(`/v1/contracts/${id}/content`, { bodyHtml: html }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', id] });
      qc.invalidateQueries({ queryKey: ['versions', id] });
      nav(`/contracts/${id}`);
    },
  });

  if (detail.isLoading || (versionId && version.isLoading)) return <Spinner />;
  if (detail.error || !detail.data) return <p className="text-red-600">Contrat introuvable.</p>;
  if (!EDITABLE.includes(detail.data.contract.status)) {
    return <p className="text-gray-600">Ce contrat n’est pas modifiable dans son état actuel.</p>;
  }

  const error = m.error instanceof ApiError ? m.error.message : m.error ? 'Erreur.' : undefined;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Éditer le contenu</h1>
      <ContentEditor
        initialHtml={version.data?.bodyHtml ?? ''}
        saving={m.isPending}
        onSave={(html) => m.mutate(html)}
        onPreview={() => window.open(`/v1/contracts/${id}/preview.pdf`, '_blank', 'noopener')}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
