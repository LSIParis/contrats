import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { reminderKindLabel, reminderStatusLabel } from '../../lib/labels.js';
import { Badge } from '../../ui/badge.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

interface ReminderRow {
  id: string;
  contractId: string;
  contractReference: string;
  kind: string;
  offsetDays: number;
  dueAt: string;
  status: string;
  late: boolean;
}

const STATUSES = ['PENDING', 'SENT', 'SKIPPED_OBSOLETE', 'CANCELLED', 'FAILED'];
const TONE: Record<string, 'info' | 'success' | 'muted' | 'danger' | 'neutral'> = {
  PENDING: 'info', SENT: 'success', SKIPPED_OBSOLETE: 'muted', CANCELLED: 'muted', FAILED: 'danger',
};

/** Écran « Rappels » (GET /v1/reminders) : rappels d'échéance du portefeuille, triés par date. */
export function RemindersPage() {
  const [status, setStatus] = useState('PENDING');
  const q = useQuery({
    queryKey: ['reminders', status],
    queryFn: () => apiGet<{ items: ReminderRow[]; total: number }>(`/v1/reminders${status ? `?status=${status}` : ''}`),
  });
  const items = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h1>Rappels</h1>
      <Card>
        <div className="mb-3 max-w-xs">
          <Field label="Statut" htmlFor="rem-status">
            <Select id="rem-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tous</option>
              {STATUSES.map((s) => <option key={s} value={s}>{reminderStatusLabel(s)}</option>)}
            </Select>
          </Field>
        </div>
        {q.isLoading ? <Spinner /> : q.error ? (
          <p role="alert" className="text-sm text-danger">Rappels indisponibles.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">Aucun rappel.</p>
        ) : (
          <>
            <p className="mb-2 text-13 text-ink-muted">{q.data?.total ?? items.length} rappel(s)</p>
            <Table caption="Rappels d’échéance" head={<tr><th>Contrat</th><th>Nature</th><th>Échéance</th><th>Statut</th></tr>}>
              {items.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/contracts/${r.contractId}?onglet=echeances`} className="text-primary hover:underline">{r.contractReference}</Link></td>
                  <td>{reminderKindLabel(r.kind)}</td>
                  <td>J-{r.offsetDays} · {new Date(r.dueAt).toLocaleDateString('fr-FR')}</td>
                  <td className="flex flex-wrap gap-1">
                    <Badge tone={TONE[r.status] ?? 'neutral'}>{reminderStatusLabel(r.status)}</Badge>
                    {r.late && <Badge tone="danger">En retard</Badge>}
                  </td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}
