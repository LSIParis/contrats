import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { proposalAdminApi, type LibraryItem } from './proposal-api.js';

/** Choix d'un contenu de la bibliothèque (dossiers, version, relecture juridique). Le texte est COPIÉ dans la proposition. */
export function LibraryPicker({ onClose, onPick }: { onClose: () => void; onPick: (item: LibraryItem) => void }) {
  const q = useQuery({ queryKey: ['proposal-library'], queryFn: proposalAdminApi.library });
  const [filter, setFilter] = useState('');
  const items = (q.data?.items ?? []).filter((i) => `${i.title} ${i.folder} ${i.key}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const folders = [...new Set(items.map((i) => i.folder))];
  return (
    <Modal open onClose={onClose} title="Bibliothèque de contenus" width={720}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="biblio-filtre" className="text-xs+ font-button text-ink-muted">Rechercher</label>
          <Input id="biblio-filtre" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{errorMessage(q.error)}</ErrorNote> : items.length === 0 ? (
          <p className="text-13 text-ink-muted">Aucun contenu.</p>
        ) : (
          folders.map((f) => (
            <div key={f} className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-[.03em] text-ink-faint">{f}</p>
              <ul className="flex flex-col gap-2">
                {items.filter((i) => i.folder === f).map((i) => (
                  <li key={i.key} className="flex flex-col gap-1 rounded border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-button text-ink">{i.title}</span>
                      <Badge tone="muted">v{i.version}</Badge>
                      {i.requiresLegalReview && <Badge tone="warn">Relecture juridique requise</Badge>}
                      <span className="flex-1" />
                      <Button size="sm" onClick={() => onPick(i)}>Insérer « {i.title} »</Button>
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap text-13 text-ink-muted">{i.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
