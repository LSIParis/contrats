import { useMutation } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { clauseCategoryLabel } from '../../lib/labels.js';
import { Button } from '../../ui/button.js';
import { RiskBadge } from '../structure/clause-badges.js';
import { AiSources } from './ai-notice.js';
import type { MissingClausesResult } from './ai-api.js';

/** Détection des clauses manquantes (par rapport au contrat type et aux usages). Rien n'est ajouté d'office. */
export function MissingClausesPanel({ contractId, disabledReason }: { contractId: string; disabledReason: string | null }) {
  const m = useMutation({ mutationFn: () => apiPost<MissingClausesResult>(`/v1/contracts/${contractId}/ai/missing-clauses`, {}) });
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" variant="secondary" disabled={!!disabledReason || m.isPending} title={disabledReason ?? undefined} onClick={() => m.mutate()}>
          {m.isPending ? 'Analyse en cours…' : 'Détecter les clauses manquantes'}
        </Button>
      </div>
      {m.error && <p role="alert" className="text-sm text-danger">{errorMessage(m.error)}</p>}
      {m.data && (
        <section aria-label="Clauses manquantes" className="flex flex-col gap-2">
          {m.data.missing.length === 0 ? (
            <p className="text-sm text-success">Aucune clause manquante détectée.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {m.data.missing.map((c) => (
                <li key={c.title} className="rounded border border-line px-3 py-2 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-button text-ink">
                    {c.title} <span className="text-xs text-ink-faint">{clauseCategoryLabel(c.category)}</span> <RiskBadge risk={c.riskLevel} />
                  </p>
                  <p className="text-13 text-ink-muted">{c.reason}</p>
                </li>
              ))}
            </ul>
          )}
          <AiSources sources={m.data.sources} warnings={m.data.warnings} />
        </section>
      )}
    </div>
  );
}
