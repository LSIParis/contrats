import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { acceptanceMethodLabel } from '../../lib/labels.js';
import { Card } from '../../ui/card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

export interface Acceptance {
  id: string;
  versionId: string;
  method: string;
  acceptedByName: string;
  acceptedByEmail: string;
  ip: string | null;
  acceptedAt: string;
  evidenceNote: string | null;
  versionPdfSha256: string | null;
}

/** Historique des acceptations (append-only) : qui, quand, depuis où, quelle version. */
export function AcceptancesBlock({ contractId, currentVersionId }: { contractId: string; currentVersionId: string | null }) {
  const q = useQuery({
    queryKey: ['acceptances', contractId],
    queryFn: () => apiGet<{ items: Acceptance[] }>(`/v1/contracts/${contractId}/acceptances`),
  });
  const items = q.data?.items ?? [];
  return (
    <Card title="Acceptation par le client">
      {q.isLoading ? <Spinner /> : q.error ? (
        <p role="alert" className="text-sm text-danger">Historique des acceptations indisponible.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-faint">Aucune acceptation enregistrée.</p>
      ) : (
        <Table caption="Historique des acceptations" head={<tr><th>Date</th><th>Par</th><th>Voie</th><th>Version</th><th>Justificatif</th></tr>}>
          {items.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.acceptedAt).toLocaleString('fr-FR')}</td>
              <td>{a.acceptedByName}<br /><span className="text-xs text-ink-faint">{a.acceptedByEmail}{a.ip ? ` · IP ${a.ip}` : ''}</span></td>
              <td>{acceptanceMethodLabel(a.method)}</td>
              <td>
                <code className="text-xs">{a.versionId.slice(0, 8)}</code>
                {a.versionId === currentVersionId ? <span className="ml-1 text-xs text-success">(version courante)</span> : <span className="ml-1 text-xs text-warn">(version antérieure)</span>}
              </td>
              <td className="text-13">{a.evidenceNote ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
