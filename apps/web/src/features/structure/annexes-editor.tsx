import { useState } from 'react';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Badge } from '../../ui/badge.js';
import { ANNEX_KIND_CODES, annexKindLabel } from '../../lib/labels.js';
import { RichText } from './rich-text.js';
import type { SaveAnnex } from './structure-api.js';

export interface DraftAnnex extends SaveAnnex {
  uid: string;
}

/** Annexes générées par l'application (grille tarifaire, liste d'équipements) : pas de texte saisi. */
export const GENERATED_ANNEXES = ['PRICING_GRID', 'ASSETS'];

interface AssetItem { designation?: string; reference?: string; quantity?: number }

/** Contenu d'une annexe générée, en lecture seule. */
export function GeneratedAnnexNote({ annex }: { annex: SaveAnnex }) {
  if (annex.kind === 'PRICING_GRID') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <Badge tone="info">À générer</Badge>
        Grille tarifaire générée à partir du barème du contrat en vigueur à la date d’effet (onglet Tarification).
      </p>
    );
  }
  const items = ((annex.data as { items?: AssetItem[] } | null | undefined)?.items ?? []);
  if (items.length === 0) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <Badge tone="info">À générer</Badge>
        Liste des équipements couverts, générée à partir des données de l’annexe.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Équipements couverts</caption>
      <thead><tr className="text-left text-xs text-ink-faint"><th>Désignation</th><th>Référence</th><th>Quantité</th></tr></thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i} className="border-t border-line"><td>{it.designation ?? ''}</td><td>{it.reference ?? ''}</td><td>{Number(it.quantity ?? 1)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function AnnexesEditor({ annexes, onChange }: { annexes: DraftAnnex[]; onChange: (next: DraftAnnex[]) => void }) {
  const [kind, setKind] = useState<string>('SLA');
  const update = (uid: string, patch: Partial<DraftAnnex>) => onChange(annexes.map((a) => (a.uid === uid ? { ...a, ...patch } : a)));

  return (
    <div className="flex flex-col gap-3">
      {annexes.length === 0 && <p className="text-sm text-ink-faint">Aucune annexe.</p>}
      <ol className="flex flex-col gap-3" aria-label="Annexes du contrat">
        {annexes.map((a, i) => {
          const generated = GENERATED_ANNEXES.includes(a.kind);
          return (
            <li key={a.uid} className="flex flex-col gap-2 rounded border border-line px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-13 font-button text-ink">Annexe {i + 1}</span>
                <Badge tone="muted">{annexKindLabel(a.kind)}</Badge>
                <Button type="button" size="sm" variant="danger-ghost" className="ml-auto" aria-label={`Supprimer l’annexe ${a.title}`}
                  onClick={() => onChange(annexes.filter((x) => x.uid !== a.uid))}>
                  Supprimer
                </Button>
              </div>
              <Field label={`Titre de l’annexe ${i + 1}`} htmlFor={`an-title-${a.uid}`}>
                <Input id={`an-title-${a.uid}`} value={a.title} maxLength={200} onChange={(e) => update(a.uid, { title: e.target.value })} />
              </Field>
              {generated ? (
                <GeneratedAnnexNote annex={a} />
              ) : (
                <RichText label={`Texte de l’annexe « ${a.title} »`} value={a.bodyHtml ?? ''} onChange={(html) => update(a.uid, { bodyHtml: html })} />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Type d’annexe à ajouter" htmlFor="annex-kind">
          <Select id="annex-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ANNEX_KIND_CODES.map((k) => <option key={k} value={k}>{annexKindLabel(k)}</option>)}
          </Select>
        </Field>
        <Button type="button" variant="secondary"
          onClick={() => onChange([...annexes, { uid: `new-${Date.now()}-${annexes.length}`, kind, title: annexKindLabel(kind), bodyHtml: GENERATED_ANNEXES.includes(kind) ? null : '', data: null }])}>
          Ajouter l’annexe
        </Button>
      </div>
    </div>
  );
}
