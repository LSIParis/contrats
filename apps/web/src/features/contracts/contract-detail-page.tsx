import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { StatusBadge } from '../../ui/badge.js';
import { SignatureBlock, type SignatureData } from './signature-block.js';
import { RemindersBlock, type Reminder } from './reminders-block.js';
import { Timeline, type Event } from './timeline.js';

interface Detail {
  contract: { reference: string; title: string; status: string; startDate: string | null; endDate: string | null };
  customer: { name: string };
  signatureRequest: SignatureData | null;
  reminders: Reminder[];
  timeline: Event[];
}

async function downloadSigned(id: string) {
  const { url } = await apiGet<{ url: string }>(`/v1/contracts/${id}/signed-document`);
  window.open(url, '_blank', 'noopener');
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Contrat introuvable.</p>;
  const { contract, customer } = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{contract.reference} — {contract.title}</h1>
          <p className="text-gray-500">{customer.name} · <StatusBadge status={contract.status} /></p>
          <p className="text-sm text-gray-400">
            {contract.startDate ? new Date(contract.startDate).toLocaleDateString('fr-FR') : '—'}
            {' → '}
            {contract.endDate ? new Date(contract.endDate).toLocaleDateString('fr-FR') : '—'}
          </p>
        </div>
        <Button onClick={() => id && downloadSigned(id)}>Télécharger le signé</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SignatureBlock data={q.data.signatureRequest} />
        <RemindersBlock reminders={q.data.reminders} />
      </div>
      <Timeline events={q.data.timeline} />
    </div>
  );
}
