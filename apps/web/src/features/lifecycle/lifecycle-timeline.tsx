import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { actorKindLabel, contractStatusLabel, lifecycleEventLabel } from '../../lib/labels.js';
import { Card } from '../../ui/card.js';
import { Spinner } from '../../ui/spinner.js';
import { StatusBadge } from '../../ui/status-badge.js';

export interface LifecycleItem {
  at: string;
  from: string | null;
  to: string;
  event: string | null;
  reason: string | null;
  actor: { id: string; name: string | null } | null;
  actorKind: string;
}

/**
 * Journal des transitions (GET /v1/contracts/:id/lifecycle, écrit par
 * trigger) : qui, quand, de quel état vers lequel, par quel événement, pour
 * quel motif — négociation, acceptation, renouvellement, résiliation…
 */
export function LifecycleTimeline({ contractId }: { contractId: string }) {
  const q = useQuery({
    queryKey: ['lifecycle', contractId],
    queryFn: () => apiGet<{ items: LifecycleItem[] }>(`/v1/contracts/${contractId}/lifecycle`),
  });
  const items = [...(q.data?.items ?? [])].reverse();
  return (
    <Card title="Cycle de vie">
      {q.isLoading ? <Spinner /> : q.error ? (
        <p role="alert" className="text-sm text-danger">Journal du cycle de vie indisponible.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-faint">Aucune transition enregistrée.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Transitions du contrat">
          {items.map((e, i) => (
            <li key={`${e.at}-${i}`} className="border-l-2 border-line pl-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-button text-ink">{e.event ? lifecycleEventLabel(e.event) : `Passage en « ${contractStatusLabel(e.to)} »`}</span>
                {e.from && <><StatusBadge status={e.from} /><span aria-hidden="true">→</span><span className="sr-only">vers</span></>}
                <StatusBadge status={e.to} />
              </p>
              <p className="text-13 text-ink-muted">
                {new Date(e.at).toLocaleString('fr-FR')} — {e.actor?.name ?? actorKindLabel(e.actorKind)}
              </p>
              {e.reason && <p className="text-13 text-ink">Motif : {e.reason}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
