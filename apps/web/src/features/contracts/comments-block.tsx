import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api.js';
import { Card } from '../../ui/card.js';
import { Button } from '../../ui/button.js';
import { commentVisibilityLabel } from '../../lib/labels.js';

interface Comment {
  id: string;
  body: string;
  visibility: 'INTERNAL' | 'SHARED';
  author: { fullName: string };
  createdAt: string;
}

export function CommentsBlock({ contractId }: { contractId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState<'INTERNAL' | 'SHARED'>('INTERNAL');
  const q = useQuery({
    queryKey: ['comments', contractId],
    queryFn: () => apiGet<{ items: Comment[] }>(`/v1/contracts/${contractId}/comments`),
  });
  const send = useMutation({
    mutationFn: (payload: { body: string; visibility: 'INTERNAL' | 'SHARED' }) =>
      apiPost(`/v1/contracts/${contractId}/comments`, payload),
    onSuccess: () => { setDraft(''); setVisibility('INTERNAL'); qc.invalidateQueries({ queryKey: ['comments', contractId] }); },
  });
  const items = q.data?.items ?? [];
  return (
    <Card title="Commentaires">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun commentaire.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {items.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.author.fullName}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${c.visibility === 'SHARED' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                  {commentVisibilityLabel(c.visibility)}
                </span>
                <span className="text-gray-400">· {new Date(c.createdAt).toLocaleDateString('fr-FR')}</span>
              </div>
              <div className="whitespace-pre-wrap text-gray-700">{c.body}</div>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
        placeholder="Ajouter un commentaire…"
        className="w-full rounded border border-gray-300 p-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" name="visibility" checked={visibility === 'INTERNAL'} onChange={() => setVisibility('INTERNAL')} /> Commentaire interne
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" name="visibility" checked={visibility === 'SHARED'} onChange={() => setVisibility('SHARED')} /> Partagé client (visible par le client)
        </label>
        <Button disabled={!draft.trim() || send.isPending} onClick={() => send.mutate({ body: draft.trim(), visibility })}>
          Publier
        </Button>
      </div>
      {visibility === 'SHARED' && (
        <p className="mt-2 text-sm text-amber-700">⚠ Ce commentaire sera visible du client dans son portail.</p>
      )}
      {send.isError && <p className="mt-2 text-sm text-red-600">Publication impossible.</p>}
    </Card>
  );
}
