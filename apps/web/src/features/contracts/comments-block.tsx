import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { Card } from '../../ui/card.js';
import { Button } from '../../ui/button.js';
import { commentVisibilityLabel } from '../../lib/labels.js';

interface Comment {
  id: string;
  body: string | null;
  visibility: 'INTERNAL' | 'SHARED';
  author: { fullName: string };
  authorUserId: string;
  createdAt: string;
  resolvedAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
}

const SHARE_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'];

export function CommentsBlock({ contractId }: { contractId: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const canShare = me.data?.roles?.some((r) => SHARE_ROLES.includes(r)) ?? false;
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState<'INTERNAL' | 'SHARED'>('INTERNAL');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['comments', contractId],
    queryFn: () => apiGet<{ items: Comment[] }>(`/v1/contracts/${contractId}/comments`),
  });
  const send = useMutation({
    mutationFn: (payload: { body: string; visibility: 'INTERNAL' | 'SHARED' }) =>
      apiPost(`/v1/contracts/${contractId}/comments`, payload),
    onSuccess: () => { setDraft(''); setVisibility('INTERNAL'); qc.invalidateQueries({ queryKey: ['comments', contractId] }); },
  });
  const act = (fn: () => Promise<unknown>) =>
    fn()
      .then(() => { setActionError(null); qc.invalidateQueries({ queryKey: ['comments', contractId] }); })
      .catch(() => setActionError('Action impossible sur ce commentaire.'));
  const resolve = (id: string, on: boolean) =>
    act(() => apiPost(`/v1/contracts/${contractId}/comments/${id}/${on ? 'resolve' : 'unresolve'}`, {}));
  const share = (id: string) => {
    if (confirm('Partager ce commentaire avec le client ? (irréversible)')) {
      act(() => apiPatch(`/v1/contracts/${contractId}/comments/${id}/share`, {}));
    }
  };
  const remove = (id: string) => {
    if (confirm('Supprimer ce commentaire ?')) act(() => apiDelete(`/v1/contracts/${contractId}/comments/${id}`));
  };
  const saveEdit = (id: string, body: string) => {
    // On ne referme l'édition qu'après succès (sinon l'ancien corps réapparaît
    // brièvement avant le refetch, et un échec perdrait la saisie).
    apiPatch(`/v1/contracts/${contractId}/comments/${id}`, { body })
      .then(() => { setEditing(null); setActionError(null); qc.invalidateQueries({ queryKey: ['comments', contractId] }); })
      .catch(() => setActionError('Modification impossible.'));
  };
  const items = q.data?.items ?? [];
  return (
    <Card title="Commentaires">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun commentaire.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {items.map((c) => {
            const canManage = me.data?.userId === c.authorUserId || me.data?.roles?.includes('MSP_ADMIN');
            return (
              <li key={c.id} className={`text-sm ${c.resolvedAt ? 'opacity-60' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.author.fullName}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${c.visibility === 'SHARED' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                    {commentVisibilityLabel(c.visibility)}
                  </span>
                  <span className="text-gray-400">· {new Date(c.createdAt).toLocaleDateString('fr-FR')}</span>
                  {c.resolvedAt && <span className="text-xs font-medium text-gray-500">Résolu</span>}
                </div>
                {c.deletedAt ? (
                  <div className="italic text-gray-400">message supprimé</div>
                ) : editing === c.id ? (
                  <div className="mt-1">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={2}
                      className="w-full rounded border border-gray-300 p-2 text-sm"
                    />
                    <div className="mt-1 flex gap-3 text-xs">
                      <button type="button" className="text-lsi underline" onClick={() => saveEdit(c.id, editDraft.trim())}>
                        Enregistrer
                      </button>
                      <button type="button" className="text-gray-500 underline" onClick={() => setEditing(null)}>
                        Annuler
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="whitespace-pre-wrap text-gray-700">
                      {c.body}
                      {c.editedAt && <span className="text-xs text-gray-400"> (modifié)</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs">
                      <button type="button" className="text-lsi underline" onClick={() => resolve(c.id, !c.resolvedAt)}>
                        {c.resolvedAt ? 'Rouvrir' : 'Résoudre'}
                      </button>
                      {c.visibility === 'INTERNAL' && canShare && (
                        <button type="button" className="text-lsi underline" onClick={() => share(c.id)}>
                          Partager avec le client
                        </button>
                      )}
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="text-lsi underline"
                            onClick={() => { setEditing(c.id); setEditDraft(c.body ?? ''); }}
                          >
                            Modifier
                          </button>
                          <button type="button" className="text-red-600 underline" onClick={() => remove(c.id)}>
                            Supprimer
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
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
      {actionError && <p className="mt-2 text-sm text-red-600">{actionError}</p>}
    </Card>
  );
}
