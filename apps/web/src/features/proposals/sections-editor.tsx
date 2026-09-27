import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { useToast } from '../../ui/toast.js';
import { LibraryPicker } from './library-picker.js';
import { proposalsApi, sha256Hex, type Block, type BlockType, type LibraryItem, type ProposalDetail, type Section } from './proposal-api.js';
import { BLOCK_TYPE_LABELS, findMergeTags, MERGE_TAGS, SECTION_KIND_LABELS } from './proposal-labels.js';

/**
 * Éditeur par blocs de la version courante (brief §12.3) : sections
 * ordonnées (boutons ou glisser-déposer), blocs typés, insertion depuis la
 * bibliothèque, import Word, balises de fusion affichées et contrôlées.
 *
 * Le texte est du **Markdown restreint** (le format que le serveur assainit et
 * rend en HTML, 11-propositions.md §13) : il est édité tel quel, sans
 * conversion HTML ↔ Markdown qui pourrait l'altérer. Rendu : « Aperçu ».
 * L'enregistrement réécrit toutes les sections (`PUT …/sections`) ; le
 * serveur exige une section de prix et une de signature, d'où leur verrouillage.
 */

/** Sections structurelles : jamais supprimées (tableau de prix, CGV, signature, couverture, contexte). */
const LOCKED_KINDS = new Set(['COVER', 'CLIENT_INPUT', 'PRICING', 'TERMS', 'SIGNATURE']);
/** Blocs générés par le serveur : non ajoutables, non supprimables. */
const SYSTEM_BLOCKS = new Set(['PRICING_TABLE', 'TERMS', 'SIGNATURE']);
const ADDABLE_BLOCKS: BlockType[] = ['RICH_TEXT', 'IMAGE', 'VIDEO', 'TIMELINE', 'TEAM', 'REFERENCES', 'FAQ'];

const ITEM_FIELDS: Record<string, { collection: 'items' | 'members'; fields: { key: string; label: string; long?: boolean; optional?: boolean }[] }> = {
  FAQ: { collection: 'items', fields: [{ key: 'question', label: 'Question' }, { key: 'answer', label: 'Réponse', long: true }] },
  TIMELINE: { collection: 'items', fields: [{ key: 'label', label: 'Étape' }, { key: 'date', label: 'Date', optional: true }, { key: 'description', label: 'Description', long: true, optional: true }] },
  TEAM: { collection: 'members', fields: [{ key: 'name', label: 'Nom' }, { key: 'role', label: 'Rôle' }] },
  REFERENCES: { collection: 'items', fields: [{ key: 'name', label: 'Référence' }, { key: 'description', label: 'Description', long: true, optional: true }] },
};

function emptyContent(type: BlockType): Record<string, unknown> {
  switch (type) {
    case 'RICH_TEXT': return { markdown: '' };
    case 'IMAGE': return { url: '', alt: '' };
    case 'VIDEO': return { url: '', title: '' };
    case 'TEAM': return { members: [] };
    case 'TIMELINE': case 'REFERENCES': case 'FAQ': return { items: [] };
    default: return {};
  }
}

/** Section au format strict de `PUT /v1/proposals/:id/sections` (aucun champ calculé par le serveur). */
function toInput(s: Section): Section {
  return {
    key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded,
    libraryItemKey: s.libraryItemKey, guidance: s.guidance,
    blocks: s.blocks.map((b) => ({ type: b.type, content: b.content ?? {} })),
  };
}

/** Champs optionnels vides retirés (schéma strict du serveur : chaînes bornées, pas de clé vide). */
function cleanBlock(b: Block): Block {
  const spec = ITEM_FIELDS[b.type];
  if (!spec) return b;
  const list = ((b.content[spec.collection] as Record<string, string>[] | undefined) ?? []).map((it) =>
    Object.fromEntries(Object.entries(it).filter(([k, v]) => v !== '' || !spec.fields.find((f) => f.key === k)?.optional)),
  );
  return { type: b.type, content: { [spec.collection]: list } };
}

function uniqueKey(base: string, taken: Set<string>): string {
  const slug = base.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'section';
  let k = slug;
  for (let n = 2; taken.has(k); n++) k = `${slug}-${n}`;
  return k;
}

export function SectionsEditor({ detail, me, editable, onDetail }: { detail: ProposalDetail; me: Me | undefined; editable: boolean; onDetail: (d: ProposalDetail) => void }) {
  const toast = useToast();
  const [sections, setSections] = useState<Section[]>(() => detail.version.sections.map(toInput));
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const draft = detail.proposal.status === 'DRAFT' && !detail.version.lockedAt;
  const canValidate = draft && allows(me, 'proposals.prices.validate');
  const pid = detail.proposal.id;

  // Nouvelle version du serveur (enregistrement, import, SSE) : resynchronisée si rien n'est en cours.
  useEffect(() => {
    if (!dirty) setSections(detail.version.sections.map(toInput));
  }, [detail, dirty]);

  const change = (next: Section[]) => {
    setSections(next);
    setDirty(true);
  };
  const patch = (i: number, s: Partial<Section>) => change(sections.map((x, n) => (n === i ? { ...x, ...s } : x)));
  const patchBlock = (i: number, bi: number, content: Record<string, unknown>) =>
    patch(i, { blocks: sections[i]!.blocks.map((b, n) => (n === bi ? { ...b, content } : b)) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= sections.length || from === to) return;
    const next = [...sections];
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s!);
    change(next);
  };
  /** Nouvelle section : avant le tableau de prix, les CGV et la signature. */
  const insert = (s: Section) => {
    const at = sections.findIndex((x) => x.kind === 'PRICING' || x.kind === 'TERMS' || x.kind === 'SIGNATURE');
    const next = [...sections];
    next.splice(at < 0 ? next.length : at, 0, s);
    change(next);
  };
  const taken = () => new Set(sections.map((s) => s.key));

  const save = useMutation({
    mutationFn: () => proposalsApi.putSections(pid, sections.map((s) => ({ ...toInput(s), blocks: s.blocks.map(cleanBlock) }))),
    onSuccess: (d) => {
      setDirty(false);
      onDetail(d);
      toast.show('Contenu enregistré.', 'success');
    },
  });
  const importDocx = useMutation({
    mutationFn: (f: File) => proposalsApi.importDocx(pid, f),
    onSuccess: (d) => {
      setDirty(false);
      onDetail(d);
      toast.show('Document Word importé : sections de texte remplacées.', 'success');
    },
  });
  const validateSection = useMutation({
    mutationFn: (key: string) => proposalsApi.validateSection(pid, key),
    onSuccess: (d) => {
      onDetail(d);
      toast.show('Section validée (tracée dans le journal d’audit).', 'success');
    },
  });

  const addFromLibrary = async (item: LibraryItem) => {
    const sourceSha256 = await sha256Hex(item.body);
    insert({
      key: uniqueKey(item.key, taken()), title: item.title, kind: 'LIBRARY', optional: false, excluded: false,
      libraryItemKey: item.key, guidance: null,
      blocks: [{ type: 'RICH_TEXT', content: { markdown: item.body, ...(sourceSha256 ? { sourceSha256 } : {}) } }],
    });
    setPicker(false);
  };

  const issuesOf = (key: string) => detail.readiness.issues.filter((i) => i.sectionKey === key);
  const serverSection = (key: string) => detail.version.sections.find((s) => s.key === key);

  return (
    <section aria-label="Sections de la proposition" className="flex flex-col gap-4">
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => insert({ key: uniqueKey('texte', taken()), title: 'Nouvelle section', kind: 'TEXT', optional: false, excluded: false, libraryItemKey: null, guidance: null, blocks: [{ type: 'RICH_TEXT', content: { markdown: '' } }] })}>
            Ajouter une section de texte
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPicker(true)}>Ajouter depuis la bibliothèque</Button>
          <label className="inline-flex cursor-pointer items-center gap-2 text-13 text-primary">
            <span>Importer un document Word (.docx)</span>
            <input
              type="file"
              className="sr-only"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const f = e.target.files?.[0];
                if (f) importDocx.mutate(f);
                e.target.value = '';
              }}
            />
          </label>
          <span className="flex-1" />
          {dirty && <span className="text-13 text-warn">Modifications non enregistrées</span>}
          {dirty && <Button size="sm" variant="ghost" onClick={() => { setDirty(false); setSections(detail.version.sections.map(toInput)); }}>Annuler les modifications</Button>}
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Enregistrement…' : 'Enregistrer le contenu'}</Button>
        </div>
      ) : (
        <p className="text-13 text-ink-muted">
          {detail.version.lockedAt || detail.proposal.status !== 'DRAFT'
            ? 'Version figée : réviser la proposition (nouvelle version) pour modifier le contenu.'
            : 'Lecture seule.'}
        </p>
      )}
      <ErrorNote>{errorMessage(save.error) ?? errorMessage(importDocx.error) ?? errorMessage(validateSection.error)}</ErrorNote>
      {importDocx.isPending && <p role="status" className="text-13 text-ink-muted">Import du document…</p>}

      <ol className="flex flex-col gap-3">
        {sections.map((s, i) => {
          const locked = LOCKED_KINDS.has(s.kind);
          const server = serverSection(s.key);
          const toValidate = server?.validationStatus === 'TO_VALIDATE';
          return (
            <li
              key={s.key}
              draggable={editable}
              onDragStart={() => { dragFrom.current = i; }}
              onDragOver={(e) => editable && e.preventDefault()}
              onDrop={() => { if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; }}
              className={`flex flex-col gap-3 rounded-lg border bg-surface p-4 shadow-sm ${s.excluded ? 'border-dashed border-line opacity-70' : 'border-line'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-15 font-title text-ink">{s.title}</h3>
                <Badge tone="neutral">{SECTION_KIND_LABELS[s.kind] ?? s.kind}</Badge>
                {locked && <Badge tone="muted">Obligatoire</Badge>}
                {s.optional && <Badge tone="info">Facultative</Badge>}
                {toValidate && <Badge tone="warn">À valider</Badge>}
                {server?.aiPendingReview && <Badge tone="warn">Généré par IA — à relire</Badge>}
                <span className="flex-1" />
                {canValidate && toValidate && (
                  <Button size="sm" variant="warn" disabled={validateSection.isPending} onClick={() => validateSection.mutate(s.key)}>
                    Valider la section « {s.title} »
                  </Button>
                )}
                {editable && (
                  <>
                    <Button size="sm" variant="ghost" aria-label={`Monter « ${s.title} »`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</Button>
                    <Button size="sm" variant="ghost" aria-label={`Descendre « ${s.title} »`} disabled={i === sections.length - 1} onClick={() => move(i, i + 1)}>↓</Button>
                    {!locked && (
                      <Button size="sm" variant="danger-ghost" aria-label={`Supprimer « ${s.title} »`} onClick={() => change(sections.filter((_, n) => n !== i))}>Supprimer</Button>
                    )}
                  </>
                )}
              </div>

              {editable && (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-[240px] flex-1 flex-col gap-[5px]">
                    <label htmlFor={`titre-${i}`} className="text-xs+ font-button text-ink-muted">Titre de la section {i + 1}</label>
                    <Input id={`titre-${i}`} value={s.title} onChange={(e) => patch(i, { title: e.target.value })} />
                  </div>
                  {s.optional && (
                    <label className="inline-flex items-center gap-2 pb-2 text-sm">
                      <input type="checkbox" checked={!s.excluded} onChange={(e) => patch(i, { excluded: !e.target.checked })} />
                      Inclure « {s.title} »
                    </label>
                  )}
                </div>
              )}
              {!editable && s.optional && s.excluded && <p className="text-13 text-ink-faint">Section exclue de la proposition.</p>}

              {s.guidance && <p className="rounded border border-line bg-slate-50 px-3 py-2 text-13 text-ink-muted"><strong>Consigne (jamais envoyée) :</strong> {s.guidance}</p>}
              {issuesOf(s.key).length > 0 && (
                <ul className="list-disc pl-5 text-13 text-warn">{issuesOf(s.key).map((iss, n) => <li key={n}>{iss.message}</li>)}</ul>
              )}

              {s.blocks.map((b, bi) => (
                <BlockEditor
                  key={bi}
                  block={b}
                  index={bi}
                  sectionTitle={s.title}
                  editable={editable}
                  issues={detail.readiness.issues.map((x) => x.message)}
                  termsLabel={detail.version.terms ? `CGV v${detail.version.terms.versionNumber} — ${detail.version.terms.title}` : null}
                  onChange={(c) => patchBlock(i, bi, c)}
                  onRemove={SYSTEM_BLOCKS.has(b.type) || s.blocks.length === 1 ? undefined : () => patch(i, { blocks: s.blocks.filter((_, n) => n !== bi) })}
                />
              ))}

              {editable && !locked && <AddBlock sectionTitle={s.title} onAdd={(t) => patch(i, { blocks: [...s.blocks, { type: t, content: emptyContent(t) }] })} />}
            </li>
          );
        })}
      </ol>

      {picker && <LibraryPicker onClose={() => setPicker(false)} onPick={(item) => void addFromLibrary(item)} />}
    </section>
  );
}

function AddBlock({ sectionTitle, onAdd }: { sectionTitle: string; onAdd: (t: BlockType) => void }) {
  const [type, setType] = useState<BlockType>('RICH_TEXT');
  const id = `ajout-bloc-${sectionTitle.replace(/\W+/g, '-')}`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <label htmlFor={id} className="sr-only">Type de bloc à ajouter — {sectionTitle}</label>
      <Select id={id} className="max-w-[220px]" value={type} onChange={(e) => setType(e.target.value as BlockType)}>
        {ADDABLE_BLOCKS.map((t) => <option key={t} value={t}>{BLOCK_TYPE_LABELS[t]}</option>)}
      </Select>
      <Button size="sm" variant="secondary" aria-label={`Ajouter le bloc — ${sectionTitle}`} onClick={() => onAdd(type)}>Ajouter un bloc</Button>
    </div>
  );
}

function BlockEditor({
  block, index, sectionTitle, editable, issues, termsLabel, onChange, onRemove,
}: {
  block: Block; index: number; sectionTitle: string; editable: boolean; issues: string[]; termsLabel: string | null;
  onChange: (c: Record<string, unknown>) => void; onRemove: (() => void) | undefined;
}) {
  const c = block.content ?? {};
  const suffix = index > 0 ? ` (bloc ${index + 1})` : '';
  const header = (
    <div className="flex items-center gap-2 text-xs+ font-button text-ink-muted">
      <span>{BLOCK_TYPE_LABELS[block.type] ?? block.type}</span>
      {editable && onRemove && <Button size="sm" variant="danger-ghost" aria-label={`Retirer le bloc ${index + 1} — ${sectionTitle}`} onClick={onRemove}>Retirer</Button>}
    </div>
  );
  switch (block.type) {
    case 'RICH_TEXT':
      return (
        <div className="flex flex-col gap-2">
          {header}
          {typeof c.guidance === 'string' && c.guidance && <p className="text-13 text-ink-faint">Consigne : {c.guidance}</p>}
          <MarkdownField label={`Texte (Markdown) — ${sectionTitle}${suffix}`} tagLabel={`${sectionTitle}${suffix}`} value={String(c.markdown ?? '')} editable={editable} issues={issues} onChange={(markdown) => onChange({ ...c, markdown })} />
        </div>
      );
    case 'PRICING_TABLE':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <MarkdownField label={`Introduction du tableau de prix — ${sectionTitle}`} tagLabel={`${sectionTitle} (introduction)`} value={String(c.intro ?? '')} editable={editable} issues={issues}
            onChange={(intro) => onChange(intro ? { intro } : {})} />
          <p className="text-13 text-ink-faint">Le tableau lui-même est généré par le moteur de tarification (onglet « Tarification »).</p>
        </div>
      );
    case 'TERMS':
      return <div className="flex flex-col gap-1">{header}<p className="text-13 text-ink-muted">{termsLabel ? `Jointes automatiquement : ${termsLabel}.` : 'Aucune CGV publiée : à publier dans l’administration des propositions.'}</p></div>;
    case 'SIGNATURE':
      return <div className="flex flex-col gap-1">{header}<p className="text-13 text-ink-muted">Zone d’acceptation et de signature générée à l’envoi.</p></div>;
    case 'IMAGE':
    case 'VIDEO': {
      const second = block.type === 'IMAGE' ? 'alt' : 'title';
      return (
        <div className="flex flex-col gap-2">
          {header}
          {editable ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <LabeledInput label={`Adresse (chemin /… ou https://) — ${sectionTitle}${suffix}`} value={String(c.url ?? '')} onChange={(url) => onChange({ ...c, url })} />
              <LabeledInput label={`${block.type === 'IMAGE' ? 'Texte alternatif' : 'Titre de la vidéo'} — ${sectionTitle}${suffix}`} value={String(c[second] ?? '')} onChange={(v) => onChange({ ...c, [second]: v })} />
            </div>
          ) : (
            <p className="text-13">{String(c[second] ?? '')} — {String(c.url ?? '')}</p>
          )}
        </div>
      );
    }
    default: {
      const spec = ITEM_FIELDS[block.type];
      if (!spec) return <div>{header}</div>;
      const items = (c[spec.collection] as Record<string, string>[] | undefined) ?? [];
      const set = (next: Record<string, string>[]) => onChange({ ...c, [spec.collection]: next });
      return (
        <div className="flex flex-col gap-2">
          {header}
          {items.length === 0 && <p className="text-13 text-ink-faint">Aucun élément.</p>}
          {items.map((it, n) => (
            <div key={n} className="grid gap-2 rounded border border-line p-2 sm:grid-cols-2">
              {spec.fields.map((f) =>
                editable ? (
                  <LabeledInput key={f.key} label={`${f.label} ${n + 1}`} long={f.long} value={it[f.key] ?? ''} onChange={(v) => set(items.map((x, m) => (m === n ? { ...x, [f.key]: v } : x)))} />
                ) : (
                  <p key={f.key} className="text-13"><span className="text-ink-faint">{f.label} : </span>{it[f.key] ?? ''}</p>
                ),
              )}
              {editable && <Button size="sm" variant="danger-ghost" onClick={() => set(items.filter((_, m) => m !== n))}>Retirer l’élément {n + 1}</Button>}
            </div>
          ))}
          {editable && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => set([...items, Object.fromEntries(spec.fields.map((f) => [f.key, '']))])}>Ajouter un élément</Button>
            </div>
          )}
        </div>
      );
    }
  }
}

function LabeledInput({ label, value, onChange, long }: { label: string; value: string; onChange: (v: string) => void; long?: boolean | undefined }) {
  const id = `champ-${label.replace(/\W+/g, '-')}`;
  return (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
      {long ? (
        <textarea id={id} className="min-h-[64px] w-full rounded border border-line-strong px-2.5 py-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

/** Zone Markdown + insertion de balise au curseur + état de chaque balise (catalogue, valeur). */
function MarkdownField({ label, tagLabel, value, editable, issues, onChange }: {
  label: string; tagLabel: string; value: string; editable: boolean; issues: string[]; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tag, setTag] = useState(MERGE_TAGS[0]!.tag);
  const id = `md-${label.replace(/\W+/g, '-')}`;
  const tags = findMergeTags(value);
  const insertTag = () => {
    const el = ref.current;
    const at = el ? el.selectionStart ?? value.length : value.length;
    const end = el ? el.selectionEnd ?? at : at;
    const text = `{{${tag}}}`;
    onChange(value.slice(0, at) + text + value.slice(end));
  };
  return (
    <div className="flex flex-col gap-2">
      {editable ? (
        <>
          <label htmlFor={id} className="sr-only">{label}</label>
          <textarea id={id} ref={ref} className="min-h-[120px] w-full rounded border border-line-strong bg-surface px-3 py-2 font-mono text-13" value={value} onChange={(e) => onChange(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-balise`} className="sr-only">Balise à insérer — {tagLabel}</label>
            <Select id={`${id}-balise`} className="max-w-[320px]" value={tag} onChange={(e) => setTag(e.target.value)}>
              {MERGE_TAGS.map((t) => <option key={t.tag} value={t.tag}>{t.label} ({t.tag})</option>)}
            </Select>
            <Button size="sm" variant="ghost" aria-label={`Insérer la balise — ${tagLabel}`} onClick={insertTag}>Insérer la balise</Button>
          </div>
        </>
      ) : (
        <div className="whitespace-pre-wrap rounded border border-line bg-slate-50 px-3 py-2 text-13">{value || <span className="text-ink-faint">(vide)</span>}</div>
      )}
      {tags.length > 0 && (
        <ul aria-label={`Balises de fusion — ${tagLabel}`} className="flex flex-wrap gap-1.5">
          {tags.map((t) => {
            const known = MERGE_TAGS.some((m) => m.tag === t);
            const missing = issues.some((m) => m.includes(`{{${t}}}`));
            return (
              <li key={t} className="inline-flex items-center gap-1">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{`{{${t}}}`}</code>
                {!known ? <Badge tone="danger">inconnue</Badge> : missing ? <Badge tone="warn">sans valeur</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
