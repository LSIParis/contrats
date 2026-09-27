import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { allows } from '../../lib/permissions.js';
import { CLAUSE_CATEGORY_CODES, clauseCategoryLabel } from '../../lib/labels.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { RichText } from '../structure/rich-text.js';
import { filterLibrary, libraryKey, useClauseLibrary, useLibraryClause, type LibraryItem } from './library-api.js';

const fmt = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');

function NewClauseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [category, setCategory] = useState('DIVERS');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('<p></p>');
  const m = useMutation({
    mutationFn: () => apiPost<{ id: string }>('/v1/clauses', { code: code.trim().toUpperCase(), category, title: title.trim(), bodyHtml: body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: libraryKey });
      toast.show('Clause ajoutée à la bibliothèque.', 'success');
      onClose();
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="Nouvelle clause" width={720}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Code" htmlFor="nc-code" hint="Majuscules, chiffres, _ et - (ex. CONFIDENTIALITE-STD)">
            <Input id="nc-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Catégorie" htmlFor="nc-cat">
            <Select id="nc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CLAUSE_CATEGORY_CODES.map((c) => <option key={c} value={c}>{clauseCategoryLabel(c)}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Titre" htmlFor="nc-title">
          <Input id="nc-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <RichText label="Texte de la clause" value={body} onChange={setBody} />
        {m.error && <p role="alert" className="text-sm text-danger">{errorMessage(m.error)}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={m.isPending || !code.trim() || !title.trim()}>{m.isPending ? 'Création…' : 'Créer la clause'}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
        </div>
      </form>
    </Modal>
  );
}

function ClauseDetail({ id, canManage, onClose }: { id: string; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useLibraryClause(id);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: libraryKey }); void qc.invalidateQueries({ queryKey: ['clause-library', id] }); };
  const version = useMutation({
    mutationFn: () => apiPost(`/v1/clauses/${id}/versions`, {
      bodyHtml: body,
      ...(title.trim() && title.trim() !== q.data?.title ? { title: title.trim() } : {}),
      ...(note.trim() ? { changeNote: note.trim() } : {}),
    }),
    onSuccess: () => { refresh(); setEditing(false); toast.show('Nouvelle version publiée. Les contrats existants ne sont pas modifiés.', 'success'); },
  });
  const archive = useMutation({
    mutationFn: () => apiPost(`/v1/clauses/${id}/archive`, {}),
    onSuccess: () => { refresh(); onClose(); toast.show('Clause archivée.', 'success'); },
  });
  const d = q.data;

  return (
    <Modal open onClose={onClose} title={d ? `${d.title} (${d.code})` : 'Clause'} placement="side" width={640}>
      {q.isLoading || !d ? <Spinner /> : (
        <div className="flex flex-col gap-4 text-sm">
          <p className="flex flex-wrap gap-2 text-ink-muted">
            {clauseCategoryLabel(d.category)} {d.isDemo && <Badge tone="muted">Démonstration</Badge>}
          </p>
          {canManage && !editing && (
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => {
                const cur = d.versions.find((v) => v.id === d.currentVersionId) ?? d.versions[0];
                setBody(cur?.bodyHtml ?? ''); setTitle(d.title); setNote(''); setEditing(true);
              }}>Nouvelle version</Button>
              <Button type="button" size="sm" variant="danger-ghost" disabled={archive.isPending} onClick={() => archive.mutate()}>Archiver</Button>
            </div>
          )}
          {archive.error && <p role="alert" className="text-danger">{errorMessage(archive.error)}</p>}
          {editing && (
            <form className="flex flex-col gap-3 rounded border border-line p-3" onSubmit={(e) => { e.preventDefault(); version.mutate(); }}>
              <Field label="Titre" htmlFor="cv-title"><Input id="cv-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
              <RichText label="Texte de la nouvelle version" value={body} onChange={setBody} />
              <Field label="Note de version" htmlFor="cv-note"><Input id="cv-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
              {version.error && <p role="alert" className="text-danger">{errorMessage(version.error)}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={version.isPending}>{version.isPending ? 'Publication…' : 'Publier la version'}</Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Annuler</Button>
              </div>
            </form>
          )}
          <section aria-label="Versions de la clause" className="flex flex-col gap-2">
            <h3 className="text-13 font-title text-ink">Versions</h3>
            {d.versions.map((v) => (
              <details key={v.id} open={v.id === d.currentVersionId} className="rounded border border-line px-3 py-2">
                <summary className="cursor-pointer">
                  Version {v.versionNumber} — {fmt(v.createdAt)}{v.id === d.currentVersionId ? ' (courante)' : ''}{v.changeNote ? ` — ${v.changeNote}` : ''}
                </summary>
                <div className="prose mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: v.bodyHtml }} />
                {v.variables && v.variables.length > 0 && (
                  <p className="mt-1 text-xs text-ink-faint">Variables : {v.variables.map((n) => `{{${n}}}`).join(', ')}</p>
                )}
              </details>
            ))}
          </section>
        </div>
      )}
    </Modal>
  );
}

/** Bibliothèque de clauses versionnées (brief §4) : recherche, versions, gestion (juriste, admin). */
export function LibraryPage() {
  const me = useMe();
  const canManage = allows(me.data, 'clauses.manage');
  const lib = useClauseLibrary();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const items: LibraryItem[] = filterLibrary(lib.data?.items ?? [], q, category);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1>Bibliothèque de clauses</h1>
        {canManage && <Button type="button" onClick={() => setCreating(true)}>Nouvelle clause</Button>}
      </div>
      <Card>
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_240px]">
          <Field label="Rechercher une clause" htmlFor="lib-q">
            <Input id="lib-q" type="search" value={q} placeholder="Code, titre ou texte" onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Catégorie" htmlFor="lib-cat">
            <Select id="lib-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Toutes</option>
              {CLAUSE_CATEGORY_CODES.map((c) => <option key={c} value={c}>{clauseCategoryLabel(c)}</option>)}
            </Select>
          </Field>
        </div>
        {lib.isLoading ? <Spinner /> : lib.error ? (
          <p role="alert" className="text-sm text-danger">Bibliothèque indisponible.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">Aucune clause.</p>
        ) : (
          <Table caption="Clauses de la bibliothèque" head={<tr><th>Code</th><th>Titre</th><th>Catégorie</th><th>Version</th></tr>}>
            {items.map((i) => (
              <tr key={i.id}>
                <td><code className="text-xs">{i.code}</code></td>
                <td>
                  <button type="button" className="text-left text-primary hover:underline" onClick={() => setSelected(i.id)}>{i.title}</button>
                  {i.isDemo && <span className="ml-2"><Badge tone="muted">Démonstration</Badge></span>}
                </td>
                <td>{clauseCategoryLabel(i.category)}</td>
                <td>{i.currentVersion ? `v${i.currentVersion.versionNumber}` : '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {selected && <ClauseDetail id={selected} canManage={canManage} onClose={() => setSelected(null)} />}
      {creating && <NewClauseDialog open onClose={() => setCreating(false)} />}
    </div>
  );
}
