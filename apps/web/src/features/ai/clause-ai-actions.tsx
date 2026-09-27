import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { riskLevelLabel } from '../../lib/labels.js';
import { Button } from '../../ui/button.js';
import { Modal } from '../../ui/modal.js';
import { RiskBadge } from '../structure/clause-badges.js';
import { replaceClausePayload, useSaveStructure, type Structure, type StructureClause } from '../structure/structure-api.js';
import { AiPrivacyNotice, AiSources } from './ai-notice.js';
import { SIMILARITY_FR, type ClauseAiResult } from './ai-api.js';

type Action = 'rephrase' | 'harden' | 'explain' | 'compare';
const ACTIONS: { id: Action; label: string; title: string }[] = [
  { id: 'rephrase', label: 'Reformuler', title: 'Reformulation proposée' },
  { id: 'harden', label: 'Durcir', title: 'Version durcie proposée' },
  { id: 'explain', label: 'Expliquer', title: 'Explication en langage clair' },
  { id: 'compare', label: 'Comparer', title: 'Comparaison avec la bibliothèque' },
];

/**
 * Aide IA sur UNE clause (brief §6) : la suggestion n'est JAMAIS appliquée
 * d'office. « Remplacer la clause » l'enregistre par la voie normale (nouvelle
 * version, origine IA — donc à revoir avant soumission).
 */
export function ClauseAiActions({ contractId, clause, structure, canReplace, provider, disabledReason }: {
  contractId: string;
  clause: StructureClause;
  structure: Structure;
  canReplace: boolean;
  provider: string | null | undefined;
  disabledReason: string | null;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const ask = useMutation({
    mutationFn: (a: Action) => apiPost<ClauseAiResult>(`/v1/contracts/${contractId}/clauses/${encodeURIComponent(clause.clauseKey)}/ai`, { action: a }),
  });
  const save = useSaveStructure(contractId);

  const run = (a: Action) => {
    setAction(a);
    save.reset();
    ask.mutate(a);
  };
  const close = () => { setAction(null); ask.reset(); };
  const meta = ACTIONS.find((x) => x.id === action);
  const r = ask.data;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Assistance IA — ${clause.title}`}>
        {ACTIONS.map((a) => (
          <Button key={a.id} type="button" size="sm" variant="ghost" disabled={!!disabledReason}
            title={disabledReason ?? undefined} aria-label={`${a.label} la clause ${clause.title}`} onClick={() => run(a.id)}>
            {a.label}
          </Button>
        ))}
      </div>
      <Modal open={!!action} onClose={close} title={`${meta?.title ?? ''} — ${clause.title}`} width={720}>
        <div className="flex flex-col gap-3 text-sm">
          <AiPrivacyNotice provider={provider} />
          {ask.isPending && <p role="status" className="text-ink-muted">Interrogation du fournisseur IA… (jusqu’à une minute)</p>}
          {ask.error && <p role="alert" className="text-danger">{errorMessage(ask.error)}</p>}
          {r && (r.action === 'rephrase' || r.action === 'harden') && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-button text-ink">{r.suggestion.title}</span>
                <RiskBadge risk={r.suggestion.riskLevel} />
              </div>
              <div className="prose max-w-none rounded border border-line bg-page px-3 py-2" dangerouslySetInnerHTML={{ __html: r.suggestion.bodyHtml }} />
              <p className="text-13 text-ink-muted"><span className="font-button text-ink">Justification : </span>{r.suggestion.justification}</p>
              {r.changes.length > 0 && (
                <div className="text-13"><p className="font-button text-ink">Modifications</p>
                  <ul className="ml-4 list-disc">{r.changes.map((c) => <li key={c}>{c}</li>)}</ul>
                </div>
              )}
              <AiSources sources={r.sources} warnings={r.warnings} />
              {save.error && <p role="alert" className="text-danger">{errorMessage(save.error)}</p>}
              {canReplace ? (
                <div className="flex gap-2">
                  <Button type="button" disabled={save.isPending} onClick={() => save.mutate(
                    replaceClausePayload(structure, clause.clauseKey, { title: r.suggestion.title, bodyHtml: r.suggestion.bodyHtml },
                      `Clause « ${clause.title} » remplacée par la suggestion IA (${r.action === 'harden' ? 'durcie' : 'reformulée'})`),
                    { onSuccess: close },
                  )}>
                    {save.isPending ? 'Enregistrement…' : 'Remplacer la clause'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={close}>Ignorer</Button>
                </div>
              ) : (
                <p className="text-13 text-ink-faint">Le contenu n’est pas modifiable : suggestion en lecture seule.</p>
              )}
            </>
          )}
          {r && r.action === 'explain' && (
            <>
              <p>{r.explanation.summary}</p>
              {r.explanation.keyPoints.length > 0 && (
                <div><p className="font-button text-ink">Points clés</p><ul className="ml-4 list-disc">{r.explanation.keyPoints.map((k) => <li key={k}>{k}</li>)}</ul></div>
              )}
              {r.explanation.pointsOfAttention.length > 0 && (
                <div><p className="font-button text-warn">Points d’attention</p><ul className="ml-4 list-disc">{r.explanation.pointsOfAttention.map((k) => <li key={k}>{k}</li>)}</ul></div>
              )}
              <AiSources sources={r.sources} warnings={r.warnings} />
            </>
          )}
          {r && r.action === 'compare' && (
            <>
              <p className="font-button text-ink">{SIMILARITY_FR[r.comparison.similarity] ?? r.comparison.similarity}</p>
              {r.comparison.differences.length > 0 && (
                <table className="w-full text-13">
                  <caption className="sr-only">Différences avec la bibliothèque</caption>
                  <thead><tr className="text-left text-xs text-ink-faint"><th>Aspect</th><th>Clause</th><th>Bibliothèque</th><th>Risque</th></tr></thead>
                  <tbody>
                    {r.comparison.differences.map((d) => (
                      <tr key={d.aspect} className="border-t border-line align-top">
                        <td className="pr-2">{d.aspect}</td><td className="pr-2">{d.clause}</td><td className="pr-2">{d.library}</td><td>{riskLevelLabel(d.riskLevel)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p><span className="font-button text-ink">Recommandation : </span>{r.comparison.recommendation}</p>
              <AiSources sources={r.sources} warnings={r.warnings} />
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
