import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { proposalsApi, type ProposalDetail, type Tracking } from './proposal-api.js';
import { formatDateTime, formatDuration, label, proposalStatusLabel, VIEW_EVENT_LABELS } from './proposal-labels.js';

/**
 * Suivi de lecture (brief §12.5) : synthèse, temps par section, chronologie
 * par destinataire, historique des statuts. Données PSEUDONYMES collectées par
 * l'application seule (IP tronquée, aucun traceur tiers), détail purgé après
 * décision ou expiration, agrégats conservés (11-propositions.md §8).
 */
export function TrackingPanel({ detail }: { detail: ProposalDetail }) {
  const pid = detail.proposal.id;
  const q = useQuery({ queryKey: ['proposal-tracking', pid], queryFn: () => proposalsApi.tracking(pid) });
  const title = (key: string | null) => detail.version.sections.find((s) => s.key === key)?.title ?? key ?? '';

  return (
    <section aria-label="Suivi de lecture" className="flex flex-col gap-4">
      <p role="note" className="rounded-lg border border-info bg-info-bg px-4 py-3 text-13 text-info">
        Suivi limité au nécessaire commercial (ouvertures, temps par section, téléchargements) et collecté par l’application seule :
        aucun traceur tiers ni outil d’analyse externe, adresse IP tronquée. Le client en est informé par un bandeau sur la page ;
        le détail est purgé après la décision ou l’expiration (durée paramétrable), seuls les agrégats sont conservés.
      </p>
      {q.isLoading ? <Spinner /> : q.error || !q.data ? <ErrorNote>{errorMessage(q.error, 'Suivi indisponible.')}</ErrorNote> : <TrackingBody t={q.data} detail={detail} title={title} />}
    </section>
  );
}

function TrackingBody({ t, detail, title }: { t: Tracking; detail: ProposalDetail; title: (k: string | null) => string }) {
  const total = t.stats.find((s) => s.sectionKey === '');
  const bySection = t.stats.filter((s) => s.sectionKey !== '');
  const groups = [
    ...detail.recipients.map((r) => ({ id: r.id as string | null, name: r.fullName })),
    ...(t.events.some((e) => !e.recipientId || !detail.recipients.some((r) => r.id === e.recipientId)) ? [{ id: null, name: 'Destinataire non identifié' }] : []),
  ];
  const eventsOf = (id: string | null) =>
    t.events.filter((e) => (id ? e.recipientId === id : !e.recipientId || !detail.recipients.some((r) => r.id === e.recipientId)));

  return (
    <>
      <dl className="grid gap-3 rounded-lg border border-line bg-surface p-4 text-sm shadow-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Envoyée le', formatDateTime(t.sentAt)],
          ['Première ouverture', formatDateTime(t.firstViewedAt)],
          ['Dernière activité', formatDateTime(t.lastActivityAt)],
          ['Ouvertures', String(total?.opens ?? 0)],
          ['Temps de lecture', formatDuration(total?.totalDurationMs)],
          ['PDF téléchargés', String(total?.pdfDownloads ?? 0)],
          ['Nouveaux lecteurs', String(total?.newViewers ?? 0)],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-ink-faint">{k}</dt>
            <dd className="font-button tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      {bySection.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface p-4 shadow-sm">
          <table className="w-full border-collapse text-sm">
            <caption className="mb-2 text-left text-15 font-title text-ink">Lecture par section</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs+ text-ink-muted">
                <th scope="col" className="py-2 pr-3 font-button">Section</th><th scope="col" className="py-2 pr-3 text-right font-button">Ouvertures</th>
                <th scope="col" className="py-2 pr-3 text-right font-button">Temps cumulé</th><th scope="col" className="py-2 font-button">Dernière lecture</th>
              </tr>
            </thead>
            <tbody>
              {bySection.map((s) => (
                <tr key={s.sectionKey} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{title(s.sectionKey)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{s.opens}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatDuration(s.totalDurationMs)}</td>
                  <td className="py-2">{formatDateTime(s.lastViewedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => {
          const events = eventsOf(g.id);
          return (
            <div key={g.id ?? 'inconnu'} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-sm">
              <h3 className="text-15 font-title text-ink">{g.name}</h3>
              {events.length === 0 ? (
                <p className="text-13 text-ink-faint">Aucune consultation enregistrée.</p>
              ) : (
                <ol aria-label={`Chronologie — ${g.name}`} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-13">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="text-ink-faint">{formatDateTime(e.occurredAt)}</span> — {label(VIEW_EVENT_LABELS, e.kind)}
                      {e.sectionKey && <> « {title(e.sectionKey)} »</>}
                      {e.durationMs ? <> ({formatDuration(e.durationMs)})</> : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>

      {t.lifecycle.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-sm">
          <h3 className="text-15 font-title text-ink">Historique des statuts</h3>
          <ol aria-label="Historique des statuts" className="flex flex-col gap-1 text-13">
            {t.lifecycle.map((l) => (
              <li key={l.id}>
                <span className="text-ink-faint">{formatDateTime(l.occurredAt)}</span> — {l.fromStatus ? proposalStatusLabel(l.fromStatus) : 'Création'} → {proposalStatusLabel(l.toStatus)}
                {l.reason && <span className="text-ink-muted"> (motif : {l.reason})</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
