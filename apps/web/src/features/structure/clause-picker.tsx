import { useState } from 'react';
import { Modal } from '../../ui/modal.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Field } from '../../ui/field.js';
import { Button } from '../../ui/button.js';
import { Spinner } from '../../ui/spinner.js';
import { Badge } from '../../ui/badge.js';
import { CLAUSE_CATEGORY_CODES, clauseCategoryLabel } from '../../lib/labels.js';
import { filterLibrary, htmlText, useClauseLibrary, type LibraryItem } from '../library/library-api.js';

/** Choix d'une clause de la bibliothèque (version courante épinglée à l'ajout). */
export function ClausePicker({ open, onClose, onPick, usedKeys }: {
  open: boolean;
  onClose: () => void;
  onPick: (item: LibraryItem) => void;
  usedKeys: ReadonlySet<string>;
}) {
  const lib = useClauseLibrary(open);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const items = filterLibrary(lib.data?.items ?? [], q, category);

  return (
    <Modal open={open} onClose={onClose} title="Ajouter une clause de la bibliothèque" width={720}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_220px]">
          <Field label="Rechercher" htmlFor="picker-q">
            <Input id="picker-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, titre ou texte" />
          </Field>
          <Field label="Catégorie" htmlFor="picker-cat">
            <Select id="picker-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Toutes</option>
              {CLAUSE_CATEGORY_CODES.map((c) => <option key={c} value={c}>{clauseCategoryLabel(c)}</option>)}
            </Select>
          </Field>
        </div>
        {lib.isLoading && <Spinner />}
        {lib.error && <p role="alert" className="text-sm text-danger">Bibliothèque indisponible.</p>}
        {!lib.isLoading && items.length === 0 && <p className="text-sm text-ink-faint">Aucune clause ne correspond.</p>}
        <ul className="flex flex-col gap-2">
          {items.map((i) => {
            const used = usedKeys.has(i.code);
            return (
              <li key={i.id} className="flex items-start justify-between gap-3 rounded border border-line px-3 py-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-button text-ink">
                    {i.title} <code className="text-xs text-ink-faint">{i.code}</code>
                    {i.isDemo && <Badge tone="muted">Démonstration</Badge>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {clauseCategoryLabel(i.category)}{i.currentVersion ? ` · version ${i.currentVersion.versionNumber}` : ''}
                  </p>
                  <p className="line-clamp-2 text-xs text-ink-faint">{htmlText(i.currentVersion?.bodyHtml ?? '').slice(0, 220)}</p>
                </div>
                <Button type="button" size="sm" variant="secondary" disabled={used || !i.currentVersion}
                  aria-label={`Ajouter la clause ${i.title}`} onClick={() => onPick(i)}>
                  {used ? 'Déjà présente' : 'Ajouter'}
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
