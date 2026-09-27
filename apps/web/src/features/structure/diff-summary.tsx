import { Icon } from '../../ui/icons.js';
import type { ClauseDiff } from './structure-api.js';

/**
 * Écarts par rapport au contrat type (brief §4) : clauses ajoutées, retirées,
 * modifiées — surlignées pour la revue interne. Calculé par l'API sur la
 * version ENREGISTRÉE.
 */
export function DiffSummary({ diff }: { diff: ClauseDiff | null }) {
  if (!diff) return <p className="text-sm text-ink-faint">Contrat rédigé sans contrat type : pas de référence à comparer.</p>;
  if (!diff.hasDeviation) {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <Icon name="checkCircle" /> Conforme au contrat type : aucune clause dérogatoire.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      {diff.requiredRemoved && (
        <p role="alert" className="flex items-center gap-2 rounded border border-danger bg-danger-bg px-3 py-2 text-danger">
          <Icon name="alertCircle" /> Une clause OBLIGATOIRE du contrat type a été retirée.
        </p>
      )}
      {diff.added.length > 0 && (
        <div>
          <p className="font-button text-ink">Clauses ajoutées ({diff.added.length})</p>
          <ul className="ml-4 list-disc">{diff.added.map((c) => <li key={c.key} className="bg-warn-bg">{c.title}</li>)}</ul>
        </div>
      )}
      {diff.removed.length > 0 && (
        <div>
          <p className="font-button text-ink">Clauses retirées ({diff.removed.length})</p>
          <ul className="ml-4 list-disc">
            {diff.removed.map((c) => <li key={c.key} className="bg-danger-bg">{c.title}{c.required ? ' (obligatoire)' : ''}</li>)}
          </ul>
        </div>
      )}
      {diff.modified.length > 0 && (
        <div>
          <p className="font-button text-ink">Clauses modifiées ({diff.modified.length})</p>
          <ul className="ml-4 list-disc">
            {diff.modified.map((c) => (
              <li key={c.key} className="bg-warn-bg">
                {c.title} — {[c.titleChanged && 'titre', c.bodyChanged && 'texte'].filter(Boolean).join(' et ')} modifié{c.titleChanged && c.bodyChanged ? 's' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
