import { useMemo, useState } from 'react';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ApiError } from '../../lib/api.js';
import { ClauseListEditor, type DraftClause } from './clause-list-editor.js';
import { AnnexesEditor, type DraftAnnex } from './annexes-editor.js';
import { ClausePicker } from './clause-picker.js';
import { DiffSummary } from './diff-summary.js';
import { VariablesPanel } from './variables-panel.js';
import { isBlank, usedVariables, variableRows } from './variables.js';
import type { SaveStructurePayload, Structure } from './structure-api.js';

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

function initialClauses(s: Structure): DraftClause[] {
  return s.clauses.map((c) => ({
    uid: c.id,
    clauseKey: c.clauseKey,
    title: c.title,
    category: c.category,
    bodyHtml: c.bodyHtml,
    origin: c.origin,
    sourceClauseVersionId: c.sourceClauseVersionId,
    ai: c.ai,
  }));
}

function initialValues(s: Structure): Record<string, string> {
  return Object.fromEntries(Object.entries(s.variables.values ?? {}).map(([k, v]) => [k, isBlank(v) ? '' : String(v)]));
}

/** Détail d'une erreur d'enregistrement : message serveur + variables invalides ou inconnues. */
function saveErrorDetails(e: unknown): string[] {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') return [];
  const b = e.body as { invalid?: { name: string; message: string }[]; unknown?: string[] };
  return [
    ...(b.invalid ?? []).map((i) => `${i.name} : ${i.message}`),
    ...(b.unknown ?? []).map((n) => `${n} : variable inconnue du registre`),
  ];
}

/**
 * Éditeur du contenu structuré (lot 2). Chaque enregistrement crée une
 * NOUVELLE version immuable ; un contrat validé repasse en brouillon (RM-11),
 * un contrat en négociation y reste mais devra être revalidé.
 */
export function StructureEditor({ structure, status, saving, error, onSave }: {
  structure: Structure;
  status: string;
  saving: boolean;
  error: unknown;
  onSave: (payload: SaveStructurePayload) => void;
}) {
  const [clauses, setClauses] = useState<DraftClause[]>(() => initialClauses(structure));
  const [annexes, setAnnexes] = useState<DraftAnnex[]>(() =>
    structure.annexes.map((a) => ({ uid: a.id, kind: a.kind, title: a.title, bodyHtml: a.bodyHtml, data: a.data })));
  const initial = useMemo(() => initialValues(structure), [structure]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [summary, setSummary] = useState('');
  const [picking, setPicking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const names = usedVariables([...clauses, ...annexes]);
  const rows = variableRows(names, values, structure.variables.definitions ?? {}, structure.variables.custom ?? {});
  const usedKeys = new Set(clauses.map((c) => c.clauseKey).filter((k): k is string => !!k));

  function save() {
    setLocalError(null);
    if (clauses.length === 0) return setLocalError('Un contrat doit compter au moins une clause.');
    if (clauses.some((c) => !c.title.trim())) return setLocalError('Chaque clause doit avoir un titre.');
    if (annexes.some((a) => !a.title.trim())) return setLocalError('Chaque annexe doit avoir un titre.');
    // Seules les valeurs modifiées partent : l'API conserve les autres.
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (initial[k] ?? '') !== v));
    onSave({
      clauses: clauses.map(({ uid: _u, ai: _a, ...c }) => ({ ...c, title: c.title.trim() })),
      annexes: annexes.map(({ uid: _u, ...a }) => ({ ...a, title: a.title.trim() })),
      variables: changed,
      ...(summary.trim() ? { changeSummary: summary.trim() } : {}),
    });
  }

  const serverError = error instanceof ApiError ? error.message : error ? 'Enregistrement impossible.' : null;
  const details = saveErrorDetails(error);

  return (
    <div className="flex flex-col gap-4">
      {status === 'APPROVED' && (
        <p className="rounded border border-warn bg-warn-bg px-3 py-2 text-sm text-warn">
          Ce contrat est validé : l’enregistrer créera une nouvelle version et le repassera en brouillon (nouvelle revue interne).
        </p>
      )}
      {status === 'IN_NEGOTIATION' && (
        <p className="rounded border border-info bg-info-bg px-3 py-2 text-sm text-info">
          Contrat en négociation : la nouvelle version devra être revalidée avant d’être renvoyée au client.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <Card title="Clauses" actions={
            <span className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setPicking(true)}>Ajouter depuis la bibliothèque</Button>
              <Button type="button" size="sm" variant="secondary"
                onClick={() => setClauses((cs) => [...cs, { uid: uid('new'), title: 'Nouvelle clause', category: 'DIVERS', bodyHtml: '<p></p>', origin: 'CUSTOM', sourceClauseVersionId: null }])}>
                Ajouter une clause libre
              </Button>
            </span>
          }>
            <ClauseListEditor clauses={clauses} onChange={setClauses} />
          </Card>
          <Card title="Annexes">
            <AnnexesEditor annexes={annexes} onChange={setAnnexes} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Variables">
            <VariablesPanel rows={rows} onChange={(n, v) => setValues((xs) => ({ ...xs, [n]: v }))} />
          </Card>
          <Card title="Écarts par rapport au contrat type">
            <p className="mb-2 text-xs text-ink-faint">Calculés sur la dernière version enregistrée.</p>
            <DiffSummary diff={structure.diff} />
          </Card>
        </div>
      </div>

      <Card title="Enregistrer une nouvelle version">
        <div className="flex flex-col gap-3">
          <Field label="Résumé de la modification (facultatif)" htmlFor="change-summary">
            <Input id="change-summary" value={summary} maxLength={500} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          {(localError || serverError) && (
            <div role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
              <p>{localError ?? serverError}</p>
              {!localError && details.length > 0 && <ul className="ml-4 list-disc">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
            </div>
          )}
          <div>
            <Button type="button" disabled={saving} onClick={save}>
              {saving ? 'Enregistrement…' : 'Enregistrer (nouvelle version)'}
            </Button>
          </div>
        </div>
      </Card>

      <ClausePicker
        open={picking}
        onClose={() => setPicking(false)}
        usedKeys={usedKeys}
        onPick={(item) => {
          setClauses((cs) => [...cs, {
            uid: uid('lib'),
            clauseKey: item.code,
            title: item.title,
            category: item.category,
            bodyHtml: item.currentVersion?.bodyHtml ?? '',
            origin: 'LIBRARY',
            sourceClauseVersionId: item.currentVersion?.id ?? null,
          }]);
          setPicking(false);
        }}
      />
    </div>
  );
}
