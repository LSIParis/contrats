import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, ApiError } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Table } from '../../ui/table.js';
import { contractCategoryLabel, templateStatusLabel } from '../../lib/labels.js';
import { AiDraftPanel } from './ai-draft-panel.js';
import { TemplateEditor } from './template-editor.js';

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
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [inject, setInject] = useState<{ html: string; nonce: number } | undefined>(undefined);

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

  const aiDraft = useMutation({
    mutationFn: (input: { prompt: string; context?: string }) =>
      apiPost<{ bodyHtml: string; suggestedVariables: string[] }>(`/v1/templates/ai-draft`, { ...input, category: q.data!.category }),
    onSuccess: (data) => setInject((prev) => ({ html: data.bodyHtml, nonce: (prev?.nonce ?? 0) + 1 })),
  });

  useEffect(() => { setInject(undefined); }, [id]);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Modèle introuvable.</p>;

  const t = q.data;
  const saveHtml = bodyHtml ?? t.currentVersion?.bodyHtml ?? '';
  const saveError = save.error instanceof ApiError ? save.error.message : save.error ? 'Erreur.' : undefined;
  const publishError = publish.error instanceof ApiError ? publish.error.message : publish.error ? 'Erreur.' : undefined;
  const deprecateError = deprecate.error instanceof ApiError ? deprecate.error.message : deprecate.error ? 'Erreur.' : undefined;
  const canPublish = t.status !== 'PUBLISHED' && !editorEmpty;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t.name}</h1>
        <p className="text-gray-500">{contractCategoryLabel(t.category)} · {templateStatusLabel(t.status)}</p>
      </div>
      <Card title="Contenu">
        <div className="space-y-3">
          <TemplateEditor
            key={`${t.id}:${t.currentVersion?.id ?? 'none'}`}
            initialHtml={t.currentVersion?.bodyHtml ?? ''}
            onChange={setBodyHtml}
            onEmptyChange={setEditorEmpty}
            inject={inject}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate(saveHtml)} disabled={save.isPending}>
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
          {t.currentVersion && (
            <div className="flex flex-wrap gap-3 text-sm">
              <a href={`/v1/templates/${t.id}/export.pdf`} className="text-lsi hover:underline">Télécharger PDF</a>
              <a href={`/v1/templates/${t.id}/export.docx`} className="text-lsi hover:underline">Télécharger DOCX</a>
            </div>
          )}
          {saveError && <p className="text-sm text-red-600">{saveError}</p>}
          {publishError && <p className="text-sm text-red-600">{publishError}</p>}
          {deprecateError && <p className="text-sm text-red-600">{deprecateError}</p>}
        </div>
      </Card>
      {t.currentVersion && !t.currentVersion.isImmutable && (
        <Card title="Rédiger avec l'IA">
          <AiDraftPanel
            generating={aiDraft.isPending}
            error={aiDraft.error instanceof ApiError ? aiDraft.error.message : aiDraft.error ? 'Erreur.' : undefined}
            onGenerate={(input) => aiDraft.mutate(input)}
          />
          {aiDraft.data && aiDraft.data.suggestedVariables.length > 0 && (
            <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
              <span className="font-medium text-gray-700">Variables détectées : </span>
              <span className="text-gray-600">{aiDraft.data.suggestedVariables.join(', ')}</span>
            </div>
          )}
        </Card>
      )}
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
