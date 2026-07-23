import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Table } from '../../ui/table.js';
import { contractCategoryLabel, templateStatusLabel } from '../../lib/labels.js';

interface CurrentVersion {
  id: string; versionNumber: number; bodyHtml: string; isImmutable: boolean; publishedAt: string | null;
}
interface VersionRow {
  id: string; versionNumber: number; isImmutable: boolean; publishedAt: string | null; createdAt: string;
}
interface Detail {
  id: string; name: string; category: string; status: string;
  currentVersion: CurrentVersion | null;
  versions: VersionRow[];
}

export function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['template', id], queryFn: () => apiGet<Detail>(`/v1/templates/${id}`) });
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (html: string) => apiPut<{ versionId: string; versionNumber: number }>(`/v1/templates/${id}/content`, { bodyHtml: html }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['template', id] }),
  });

  const publish = useMutation({
    mutationFn: () => apiPost<{ ok: true }>(`/v1/templates/${id}/publish`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['template', id] }),
  });

  const deprecate = useMutation({
    mutationFn: () => apiPost<{ ok: true }>(`/v1/templates/${id}/deprecate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['template', id] }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Modèle introuvable.</p>;

  const t = q.data;
  const html = bodyHtml ?? t.currentVersion?.bodyHtml ?? '';
  const saveError = save.error instanceof ApiError ? save.error.message : save.error ? 'Erreur.' : undefined;
  const publishError = publish.error instanceof ApiError ? publish.error.message : publish.error ? 'Erreur.' : undefined;
  const deprecateError = deprecate.error instanceof ApiError ? deprecate.error.message : deprecate.error ? 'Erreur.' : undefined;
  const canPublish = t.status !== 'PUBLISHED' && html.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t.name}</h1>
        <p className="text-gray-500">{contractCategoryLabel(t.category)} · {templateStatusLabel(t.status)}</p>
      </div>
      <Card title="Contenu">
        <div className="space-y-3">
          <textarea
            className="w-full min-h-[240px] rounded border p-3 text-sm font-mono"
            value={html}
            onChange={(e) => setBodyHtml(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate(html)} disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
            <button
              type="button"
              onClick={() => publish.mutate()}
              disabled={!canPublish || publish.isPending}
              className="rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
            >
              {publish.isPending ? 'Publication…' : 'Publier'}
            </button>
            <button
              type="button"
              onClick={() => deprecate.mutate()}
              disabled={deprecate.isPending}
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {deprecate.isPending ? 'Dépréciation…' : 'Déprécier'}
            </button>
          </div>
          {saveError && <p className="text-sm text-red-600">{saveError}</p>}
          {publishError && <p className="text-sm text-red-600">{publishError}</p>}
          {deprecateError && <p className="text-sm text-red-600">{deprecateError}</p>}
        </div>
      </Card>
      <Card title="Versions">
        {t.versions.length === 0 ? (
          <p className="text-gray-400">Aucune version.</p>
        ) : (
          <Table head={<tr><th className="py-2">Version</th><th>Publiée le</th><th>Immuable</th></tr>}>
            {t.versions.map((v) => (
              <tr key={v.id} className="border-b">
                <td className="py-2">Version {v.versionNumber}</td>
                <td>{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('fr-FR') : '—'}</td>
                <td>{v.isImmutable ? 'Oui' : 'Non'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
