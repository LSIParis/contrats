import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { deadlineKindLabel } from '../../lib/labels.js';
import { Badge } from '../../ui/badge.js';
import { Card } from '../../ui/card.js';
import { Icon } from '../../ui/icons.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { StatusBadge } from '../../ui/status-badge.js';

/** Élément de `GET /v1/deadlines` et `GET /v1/contracts/:id/deadlines` (DeadlinesService.list). */
export interface Deadline {
  id: string;
  contractId: string;
  customerId: string;
  kind: string;
  dueDate: string;
  details: unknown;
  contract: { reference: string; title: string; status: string };
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` du jour LOCAL (paramètres `from`/`to` de l'API). */
export function localIsoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Jours calendaires entre aujourd'hui et l'échéance (négatif : dépassée). */
export function daysUntil(dueDate: string, now: Date = new Date()): number {
  const [y, m, d] = dueDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  const due = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / DAY_MS);
}

/** Urgence : ≤ 7 j danger, ≤ 30 j avertissement. Toujours doublée d'un texte. */
export function urgency(days: number): { tone: 'danger' | 'warn' | 'neutral'; label: string } {
  if (days <= 7) return { tone: 'danger', label: days < 0 ? 'Dépassée' : 'Urgent' };
  if (days <= 30) return { tone: 'warn', label: 'Proche' };
  return { tone: 'neutral', label: 'À venir' };
}

export function remainingText(days: number): string {
  if (days < 0) return `Dépassée de ${-days} jour${-days > 1 ? 's' : ''}`;
  if (days === 0) return 'Aujourd’hui';
  if (days === 1) return 'Demain';
  return `Dans ${days} jours`;
}

function UrgencyBadge({ days }: { days: number }) {
  const u = urgency(days);
  const icon = u.tone === 'danger' ? 'alertCircle' : u.tone === 'warn' ? 'alert' : 'clock';
  return (
    <Badge tone={u.tone}>
      <Icon name={icon} className="h-3.5 w-3.5" strokeWidth={2} />
      {u.label} · {remainingText(days)}
    </Badge>
  );
}

const fmt = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR');

export function DeadlinesTable({ items, showContract, caption }: { items: Deadline[]; showContract: boolean; caption: string }) {
  if (items.length === 0) return <p className="text-sm text-ink-faint">Aucune échéance.</p>;
  return (
    <Table
      caption={caption}
      head={
        <tr>
          <th>Échéance</th>
          <th>Date</th>
          <th>Délai</th>
          {showContract && <th>Contrat</th>}
        </tr>
      }
    >
      {items.map((d) => {
        const days = daysUntil(d.dueDate);
        return (
          <tr key={d.id}>
            <td>{deadlineKindLabel(d.kind)}</td>
            <td>{fmt(d.dueDate)}</td>
            <td><UrgencyBadge days={days} /></td>
            {showContract && (
              <td>
                <span className="flex flex-wrap items-center gap-2">
                  <Link to={`/contracts/${d.contractId}`} className="text-primary hover:underline">{d.contract.reference}</Link>
                  <span className="text-ink-muted">{d.contract.title}</span>
                  <StatusBadge status={d.contract.status} />
                </span>
              </td>
            )}
          </tr>
        );
      })}
    </Table>
  );
}

/** Widget « Échéances à venir » du tableau de bord : les 90 prochains jours. */
export function UpcomingDeadlinesWidget({ horizonDays = 90 }: { horizonDays?: number }) {
  const now = new Date();
  const from = localIsoDay(now);
  const to = localIsoDay(new Date(now.getTime() + horizonDays * DAY_MS));
  const q = useQuery({
    queryKey: ['deadlines', from, to],
    queryFn: () => apiGet<{ items: Deadline[] }>(`/v1/deadlines?from=${from}&to=${to}`),
  });
  return (
    <Card title={`Échéances à venir (${horizonDays} jours)`}>
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p role="alert" className="text-sm text-danger">Échéances indisponibles.</p>
      ) : (
        <DeadlinesTable items={q.data.items} showContract caption={`Échéances des ${horizonDays} prochains jours`} />
      )}
    </Card>
  );
}

/** Onglet « Échéances » de la fiche contrat : toutes les échéances ouvertes. */
export function ContractDeadlines({ contractId }: { contractId: string }) {
  const q = useQuery({
    queryKey: ['deadlines', 'contract', contractId],
    queryFn: () => apiGet<{ items: Deadline[] }>(`/v1/contracts/${contractId}/deadlines`),
  });
  return (
    <Card title="Échéances ouvertes">
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p role="alert" className="text-sm text-danger">Échéances indisponibles.</p>
      ) : (
        <DeadlinesTable items={q.data.items} showContract={false} caption="Échéances du contrat" />
      )}
    </Card>
  );
}
