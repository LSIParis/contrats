import { useState } from 'react';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { CLAUSE_CATEGORY_CODES, clauseCategoryLabel } from '../../lib/labels.js';
import { OriginBadge, ReviewBadge, RiskBadge } from './clause-badges.js';
import { RichText } from './rich-text.js';
import type { ClauseAiMeta, SaveClause } from './structure-api.js';

export interface DraftClause extends SaveClause {
  uid: string;
  ai?: ClauseAiMeta | null;
}

/** Liste éditable des clauses : ordre, titre, catégorie, texte, suppression. */
export function ClauseListEditor({ clauses, onChange }: { clauses: DraftClause[]; onChange: (next: DraftClause[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);

  const update = (uid: string, patch: Partial<DraftClause>) =>
    onChange(clauses.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= clauses.length) return;
    const next = [...clauses];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (uid: string) => onChange(clauses.filter((c) => c.uid !== uid));

  if (clauses.length === 0) return <p className="text-sm text-ink-faint">Aucune clause. Un contrat doit en compter au moins une.</p>;

  return (
    <ol className="flex flex-col gap-2" aria-label="Clauses du contrat">
      {clauses.map((c, i) => {
        const expanded = open === c.uid;
        const name = c.title || `clause ${i + 1}`;
        return (
          <li key={c.uid} className="rounded border border-line bg-surface">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-13 font-button text-ink">Article {i + 1} — {c.title || 'Sans titre'}</span>
              <OriginBadge origin={c.origin} />
              {c.ai && <RiskBadge risk={c.ai.risk} />}
              {c.ai && <ReviewBadge ai={c.ai} />}
              <span className="ml-auto flex flex-wrap gap-1">
                <Button type="button" size="sm" variant="ghost" aria-label={`Monter ${name}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                <Button type="button" size="sm" variant="ghost" aria-label={`Descendre ${name}`} disabled={i === clauses.length - 1} onClick={() => move(i, 1)}>↓</Button>
                <Button type="button" size="sm" variant="secondary" aria-expanded={expanded} aria-label={`${expanded ? 'Replier' : 'Modifier'} ${name}`}
                  onClick={() => setOpen(expanded ? null : c.uid)}>
                  {expanded ? 'Replier' : 'Modifier'}
                </Button>
                <Button type="button" size="sm" variant="danger-ghost" aria-label={`Supprimer ${name}`} onClick={() => remove(c.uid)}>Supprimer</Button>
              </span>
            </div>
            {expanded && (
              <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_240px]">
                  <Field label="Titre de la clause" htmlFor={`cl-title-${c.uid}`}>
                    <Input id={`cl-title-${c.uid}`} value={c.title} maxLength={200} onChange={(e) => update(c.uid, { title: e.target.value })} />
                  </Field>
                  <Field label="Catégorie" htmlFor={`cl-cat-${c.uid}`}>
                    <Select id={`cl-cat-${c.uid}`} value={c.category} onChange={(e) => update(c.uid, { category: e.target.value })}>
                      {CLAUSE_CATEGORY_CODES.map((k) => <option key={k} value={k}>{clauseCategoryLabel(k)}</option>)}
                    </Select>
                  </Field>
                </div>
                <RichText label={`Texte de la clause « ${name} »`} value={c.bodyHtml} onChange={(html) => update(c.uid, { bodyHtml: html })} />
                <p className="text-xs text-ink-faint">
                  Variables : saisissez <code>{'{{client.raisonSociale}}'}</code>, <code>{'{{contrat.dureeMois}}'}</code>… — leurs valeurs se renseignent dans le panneau Variables.
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
